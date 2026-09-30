import { useState } from 'react';
import { fileUrl } from '../api';

/**
 * Pick element on the screenshot (FR-RV-02): the page as exploration sees it, with a box for every
 * element the step can use. Numbered boxes are the candidates the rules found. A click picks the
 * smallest box under the pointer; the platform then builds and validates the locator for it.
 */

export interface ViewElement {
  ref: string;
  role: string;
  name: string;
  box: { x: number; y: number; width: number; height: number };
  candidate?: number;
}

export function PickElement(props: {
  view: { screenshot: string; width: number; height: number; elements: ViewElement[] };
  onPick: (ref: string) => void;
  busy?: boolean;
}) {
  const { view } = props;
  const [picked, setPicked] = useState<ViewElement>();
  const pct = (v: number, of: number) => `${(v / of) * 100}%`;

  const pickAt = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * view.width;
    const y = ((e.clientY - rect.top) / rect.height) * view.height;
    const under = view.elements.filter((el) => x >= el.box.x && x <= el.box.x + el.box.width && y >= el.box.y && y <= el.box.y + el.box.height);
    under.sort((a, b) => a.box.width * a.box.height - b.box.width * b.box.height);
    setPicked(under[0]);
  };

  return (
    <div className="stack">
      <p className="muted" style={{ margin: 0 }}>
        Click the element this step means. Amber boxes are the closest matches; any other usable element shows a box when you point at it.
      </p>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: the same choice is available as buttons below */}
      <div className="shot" onClick={pickAt}>
        <img src={fileUrl(view.screenshot)} alt="The page when the question was asked" />
        {view.elements.map((el) => (
          <div
            key={el.ref}
            className={`box ${picked?.ref === el.ref ? 'picked' : el.candidate !== undefined ? 'candidate' : 'other'}`}
            style={{
              left: pct(el.box.x, view.width),
              top: pct(el.box.y, view.height),
              width: pct(el.box.width, view.width),
              height: pct(el.box.height, view.height),
            }}
            title={`${el.role} "${el.name}"`}
          >
            {el.candidate !== undefined && <span className="n">{el.candidate + 1}</span>}
          </div>
        ))}
      </div>
      <div className="row">
        {picked ? (
          <>
            <span>
              Picked: <strong>{picked.role}</strong> "{picked.name || '(no name)'}"
            </span>
            <button type="button" className="primary" disabled={props.busy} onClick={() => props.onPick(picked.ref)}>
              Use this element
            </button>
            <button type="button" onClick={() => setPicked(undefined)}>
              Clear
            </button>
          </>
        ) : (
          <span className="muted">Nothing picked yet.</span>
        )}
      </div>
    </div>
  );
}
