"use client";

// A thin vertical drag handle between two columns. Reports the incremental
// pointer delta (dx in px) on each move; the parent clamps + applies it to a
// column width. Used to expand/minimize the inbox and the info/copilot pane.
import { useRef } from "react";

export function Resizer({ onResize }: { onResize: (dx: number) => void }) {
  const last = useRef(0);

  const onDown = (e: React.MouseEvent) => {
    e.preventDefault();
    last.current = e.clientX;
    const move = (ev: MouseEvent) => {
      onResize(ev.clientX - last.current);
      last.current = ev.clientX;
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  return <div className="col-resizer" onMouseDown={onDown} role="separator" aria-orientation="vertical" />;
}
