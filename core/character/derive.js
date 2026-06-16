// Deterministic derived-stat evaluator (design doc 01 §5; shared with doc 02).
//
// A tiny, SAFE arithmetic evaluator — no `eval`, no `Function`, no access to
// anything but the variables it is handed. Formulas live in template data
// (character_creation.json `derived`), so different worlds compute differently;
// this module is the single source of truth that both character creation and
// the future interaction engine call to turn stats → derived values.
//
// Supported: + - * / ( ), unary +/-, the functions floor ceil round min max,
// numeric literals, and named variables (the six stats, previously-computed
// derived keys, and `armor`). Any unknown identifier throws — a formula may
// never reach outside its variable bag.

const FUNCS = {
  floor: { arity: 1, fn: (a) => Math.floor(a) },
  ceil: { arity: 1, fn: (a) => Math.ceil(a) },
  round: { arity: 1, fn: (a) => Math.round(a) },
  // min/max are variadic (>= 1 arg)
  min: { arity: null, fn: (...a) => Math.min(...a) },
  max: { arity: null, fn: (...a) => Math.max(...a) }
};

/** Split an expression into number / identifier / operator / paren / comma tokens. */
function tokenize(expr) {
  const src = String(expr ?? "");
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    if ("+-*/(),".includes(c)) {
      tokens.push({ type: "op", value: c });
      i++;
      continue;
    }
    if (c >= "0" && c <= "9") {
      let j = i + 1;
      while (j < src.length && ((src[j] >= "0" && src[j] <= "9") || src[j] === ".")) j++;
      const num = src.slice(i, j);
      if ((num.match(/\./g) || []).length > 1) {
        throw new Error(`malformed number "${num}" in "${src}"`);
      }
      tokens.push({ type: "num", value: Number(num) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      tokens.push({ type: "ident", value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character "${c}" in "${src}"`);
  }
  return tokens;
}

/**
 * Evaluate a single formula string against a variable bag.
 * @param {string} expr
 * @param {Record<string, number>} vars
 * @returns {number}
 */
export function evaluateFormula(expr, vars = {}) {
  const tokens = tokenize(expr);
  let pos = 0;

  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  const expect = (value) => {
    const t = next();
    if (!t || t.type !== "op" || t.value !== value) {
      throw new Error(`expected "${value}" in "${expr}"`);
    }
  };

  // expr := term (('+'|'-') term)*
  function parseExpr() {
    let left = parseTerm();
    let t = peek();
    while (t && t.type === "op" && (t.value === "+" || t.value === "-")) {
      next();
      const right = parseTerm();
      left = t.value === "+" ? left + right : left - right;
      t = peek();
    }
    return left;
  }

  // term := factor (('*'|'/') factor)*
  function parseTerm() {
    let left = parseFactor();
    let t = peek();
    while (t && t.type === "op" && (t.value === "*" || t.value === "/")) {
      next();
      const right = parseFactor();
      if (t.value === "/" && right === 0) throw new Error(`division by zero in "${expr}"`);
      left = t.value === "*" ? left * right : left / right;
      t = peek();
    }
    return left;
  }

  // factor := ('+'|'-') factor | '(' expr ')' | func '(' args ')' | number | ident
  function parseFactor() {
    const t = next();
    if (!t) throw new Error(`unexpected end of "${expr}"`);
    if (t.type === "op" && (t.value === "+" || t.value === "-")) {
      const v = parseFactor();
      return t.value === "-" ? -v : v;
    }
    if (t.type === "op" && t.value === "(") {
      const v = parseExpr();
      expect(")");
      return v;
    }
    if (t.type === "num") return t.value;
    if (t.type === "ident") {
      const fn = FUNCS[t.value];
      if (fn) {
        expect("(");
        const args = [parseExpr()];
        while (peek() && peek().type === "op" && peek().value === ",") {
          next();
          args.push(parseExpr());
        }
        expect(")");
        if (fn.arity != null && args.length !== fn.arity) {
          throw new Error(`${t.value}() takes ${fn.arity} arg(s), got ${args.length}`);
        }
        return fn.fn(...args);
      }
      if (Object.prototype.hasOwnProperty.call(vars, t.value)) {
        const v = Number(vars[t.value]);
        if (!Number.isFinite(v)) throw new Error(`variable "${t.value}" is not a finite number`);
        return v;
      }
      throw new Error(`unknown identifier "${t.value}" in "${expr}"`);
    }
    throw new Error(`unexpected token "${t.value}" in "${expr}"`);
  }

  const result = parseExpr();
  if (pos !== tokens.length) {
    throw new Error(`trailing tokens after a complete expression in "${expr}"`);
  }
  return result;
}

/**
 * Evaluate an ordered map of derived formulas. Each result is folded back into
 * the variable bag so a later formula may reference an earlier derived key.
 * @param {Record<string, string>} formulas - insertion order = evaluation order
 * @param {Record<string, number>} baseVars - the six stats (+ armor, etc.)
 * @returns {Record<string, number>}
 */
export function computeDerived(formulas, baseVars = {}) {
  const out = {};
  const vars = { ...baseVars };
  for (const [key, expr] of Object.entries(formulas ?? {})) {
    const val = evaluateFormula(expr, vars);
    out[key] = val;
    vars[key] = val; // later formulas may build on this one
  }
  return out;
}
