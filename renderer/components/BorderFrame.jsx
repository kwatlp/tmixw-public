import React, { useEffect, useState } from "react";

const frameStyle = {
  position: "absolute",
  inset: 0,
  zIndex: 1,
  pointerEvents: "none",
  padding: 16
};

export default function BorderFrame({ borderMode, borderImage }) {
  const [imgUrl, setImgUrl] = useState("");
  const [showImg, setShowImg] = useState(false);

  useEffect(() => {
    let cancel = false;
    if (borderMode !== "image" || !borderImage) {
      setImgUrl("");
      setShowImg(false);
      return;
    }
    (async () => {
      const r = await window.api.getAssetPath(borderImage);
      if (cancel) return;
      if (!r.missing && r.url) {
        setImgUrl(r.url);
        setShowImg(true);
      } else {
        setShowImg(false);
      }
    })();
    return () => {
      cancel = true;
    };
  }, [borderMode, borderImage]);

  if (borderMode === "none") return null;

  if (borderMode === "image" && showImg && imgUrl) {
    return (
      <div style={frameStyle} aria-hidden>
        <div
          style={{
            width: "100%",
            height: "100%",
            backgroundImage: `url("${imgUrl}")`,
            backgroundSize: "100% 100%",
            backgroundRepeat: "no-repeat",
            opacity: 0.92
          }}
        />
      </div>
    );
  }

  if (borderMode === "image") {
    return null;
  }

  return (
    <div style={frameStyle} aria-hidden>
      <svg
        width="100%"
        height="100%"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        style={{ overflow: "visible" }}
      >
        <defs>
          <linearGradient id="borderGlow" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="rgba(212,175,55,0.35)" />
            <stop offset="100%" stopColor="rgba(212,175,55,0.08)" />
          </linearGradient>
        </defs>
        <g fill="none" strokeLinecap="square">
          <path
            d="M 4 4 L 18 4 M 4 4 L 4 18"
            stroke="url(#borderGlow)"
            strokeWidth="0.35"
            vectorEffect="non-scaling-stroke"
          />
          <path
            d="M 6 6 L 14 6 M 6 6 L 6 14"
            stroke="rgba(255,255,255,0.12)"
            strokeWidth="0.22"
            vectorEffect="non-scaling-stroke"
          />
          <path
            d="M 96 4 L 82 4 M 96 4 L 96 18"
            stroke="url(#borderGlow)"
            strokeWidth="0.35"
            vectorEffect="non-scaling-stroke"
          />
          <path
            d="M 94 6 L 86 6 M 94 6 L 94 14"
            stroke="rgba(255,255,255,0.12)"
            strokeWidth="0.22"
            vectorEffect="non-scaling-stroke"
          />
          <path
            d="M 4 96 L 18 96 M 4 96 L 4 82"
            stroke="url(#borderGlow)"
            strokeWidth="0.35"
            vectorEffect="non-scaling-stroke"
          />
          <path
            d="M 6 94 L 14 94 M 6 94 L 6 86"
            stroke="rgba(255,255,255,0.12)"
            strokeWidth="0.22"
            vectorEffect="non-scaling-stroke"
          />
          <path
            d="M 96 96 L 82 96 M 96 96 L 96 82"
            stroke="url(#borderGlow)"
            strokeWidth="0.35"
            vectorEffect="non-scaling-stroke"
          />
          <path
            d="M 94 94 L 86 94 M 94 94 L 94 86"
            stroke="rgba(255,255,255,0.12)"
            strokeWidth="0.22"
            vectorEffect="non-scaling-stroke"
          />
        </g>
      </svg>
    </div>
  );
}
