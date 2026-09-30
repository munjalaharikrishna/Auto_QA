import { useEffect, useState } from 'react';

/** A very small router on the History API: the UI has only a handful of pages. */

export function navigate(to: string): void {
  if (to === location.pathname) return;
  history.pushState(null, '', to);
  dispatchEvent(new PopStateEvent('popstate'));
}

export function usePath(): string {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const on = () => setPath(location.pathname);
    addEventListener('popstate', on);
    return () => removeEventListener('popstate', on);
  }, []);
  return path;
}

export function Link(props: { to: string; children: React.ReactNode; className?: string }) {
  return (
    <a
      href={props.to}
      className={props.className}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(props.to);
      }}
    >
      {props.children}
    </a>
  );
}
