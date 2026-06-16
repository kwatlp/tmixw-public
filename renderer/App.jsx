import React, { useCallback, useEffect, useState } from "react";
import MainApp from "./MainApp.jsx";
import Wizard from "./components/Wizard.jsx";
import Ftue from "./components/Ftue.jsx";
import CharacterForge from "./components/CharacterForge.jsx";

export default function App() {
  const [boot, setBoot] = useState(null);
  // FTUE shows once, right after the wizard finishes — not on later launches
  // (the wizard only runs on first install). Tracks the in-session handoff
  // from setup to "pick your first story".
  const [showFtue, setShowFtue] = useState(false);
  // App-owned character creation (design doc 01): set to the spec when the
  // active world has a character_creation.json and no app-forged sheet yet.
  // Rendered as an overlay above MainApp so it triggers from every entry point
  // — the FTUE first-world pick, a later WorldsModal create/switch (via
  // worlds:changed), and an interrupted forge resumed on cold relaunch.
  const [forgeSpec, setForgeSpec] = useState(null);

  // Show the forge iff the active world has a creation spec and no app-forged
  // character. Returns true when it took over (so callers can branch).
  const maybeForge = useCallback(async () => {
    try {
      const { spec } = (await window.api.characterGetSpec()) ?? {};
      if (!spec) return false;
      const { character } = (await window.api.characterGet()) ?? {};
      if (character?.createdBy === "app-forge") return false;
      setForgeSpec(spec);
      return true;
    } catch {
      return false;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const b = await window.api.getBootstrap();
        if (cancelled) return;
        setBoot(b ?? { needsWizard: true, hasBundledModel: false });
        // Cold relaunch into a templated-but-unforged world resumes the forge.
        if (b && !b.needsWizard) await maybeForge();
      } catch {
        if (!cancelled) setBoot({ needsWizard: true, hasBundledModel: false });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [maybeForge]);

  // A new world made from MainApp's WorldsModal (or a switch into an unforged
  // templated world) fires worlds:changed — re-check so its forge runs too.
  useEffect(() => {
    if (!boot || boot.needsWizard) return undefined;
    return window.api.onWorldsChanged?.(() => {
      maybeForge();
    });
  }, [boot, maybeForge]);

  if (boot === null) {
    return (
      <div className="app-root">
        <div className="bg-layer" aria-hidden />
        <div className="wizard-root" style={{ zIndex: 20 }}>
          <p className="wizard-muted" style={{ margin: 0 }}>
            Loading…
          </p>
        </div>
      </div>
    );
  }

  if (boot.needsWizard) {
    return (
      <Wizard
        onDone={() => {
          setShowFtue(true);
          setBoot((prev) => ({ ...prev, needsWizard: false }));
        }}
      />
    );
  }

  if (showFtue) {
    return (
      <Ftue
        onDone={async () => {
          // After a template is applied, drop into the forge if it ships one.
          await maybeForge();
          setShowFtue(false);
        }}
      />
    );
  }

  // MainApp stays mounted under the forge so its state (and a created world's
  // pipeline) survives; the forge is a modal layer dismissed on completion.
  return (
    <>
      <MainApp />
      {forgeSpec ? (
        <CharacterForge spec={forgeSpec} onDone={() => setForgeSpec(null)} />
      ) : null}
    </>
  );
}
