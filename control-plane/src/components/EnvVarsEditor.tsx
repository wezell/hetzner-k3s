'use client';

import { useState, useEffect, useRef } from 'react';

interface EnvVarsEditorProps {
  value: Record<string, string>;
  onChange: (vars: Record<string, string>) => void;
  disabled?: boolean;
}

/** Safely convert value prop (string or object) to rows */
function toRows(value: unknown): { k: string; v: string }[] {
  let obj: Record<string, string> = {};
  if (typeof value === 'string') {
    try { obj = JSON.parse(value); } catch { return []; }
  } else if (value && typeof value === 'object' && !Array.isArray(value)) {
    obj = value as Record<string, string>;
  }
  return Object.entries(obj).map(([k, v]) => ({ k, v: String(v) }));
}

export default function EnvVarsEditor({ value, onChange, disabled }: EnvVarsEditorProps) {
  const [rows, setRows] = useState<{ k: string; v: string }[]>(() => toRows(value));
  // Compare by JSON so object reference churn doesn't cause unnecessary row resets
  const lastValueJsonRef = useRef(JSON.stringify(value));

  useEffect(() => {
    const json = JSON.stringify(value);
    if (json !== lastValueJsonRef.current) {
      lastValueJsonRef.current = json;
      setRows(toRows(value));
    }
  }, [value]);

  function commit(next: { k: string; v: string }[]) {
    setRows(next);
    const record: Record<string, string> = {};
    for (const { k, v } of next) {
      if (k.trim()) record[k.trim()] = v;
    }
    onChange(record);
  }

  return (
    <div className="space-y-2">
      {rows.length > 0 && (
        <div className="space-y-1.5">
          <div className="grid grid-cols-[1fr_1fr_auto] gap-2 text-xs font-medium text-base-content/50 px-1">
            <span>Name</span>
            <span>Value</span>
            <span />
          </div>
          {rows.map((row, i) => (
            <div key={i} className="grid grid-cols-[1fr_1fr_auto] gap-2 items-center">
              <input
                type="text"
                value={row.k}
                onChange={(e) => commit(rows.map((r, idx) => idx === i ? { ...r, k: e.target.value } : r))}
                placeholder="VAR_NAME"
                spellCheck={false}
                disabled={disabled}
                className="input input-sm font-mono text-xs w-full"
              />
              <input
                type="text"
                value={row.v}
                onChange={(e) => commit(rows.map((r, idx) => idx === i ? { ...r, v: e.target.value } : r))}
                placeholder="value"
                spellCheck={false}
                disabled={disabled}
                className="input input-sm font-mono text-xs w-full"
              />
              <button
                type="button"
                onClick={() => commit(rows.filter((_, idx) => idx !== i))}
                disabled={disabled}
                aria-label={`Remove ${row.k || `row ${i + 1}`}`}
                className="btn btn-xs btn-ghost text-error"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
      <button
        type="button"
        onClick={() => commit([...rows, { k: '', v: '' }])}
        disabled={disabled}
        className="btn btn-xs btn-ghost gap-1"
      >
        + Add variable
      </button>
    </div>
  );
}
