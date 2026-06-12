import React, { useEffect, useState } from "react";
import MainApp from "./MainApp.jsx";
import Wizard from "./components/Wizard.jsx";

export default function App() {
  const [boot, setBoot] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const b = await window.api.getBootstrap();
        if (!cancelled) setBoot(b ?? { needsWizard: true, hasBundledModel: false });
      } catch {
        if (!cancelled) {
          setBoot({ needsWizard: true, hasBundledModel: false });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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
        onDone={() => setBoot((prev) => ({ ...prev, needsWizard: false }))}
      />
    );
  }

  return <MainApp />;
}
