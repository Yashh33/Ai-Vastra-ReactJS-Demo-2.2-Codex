import { useEffect, useRef, useState, type ChangeEvent } from "react";

import { normalizeToJpeg } from "../lib/compressImage";

// TEMPORARY: iPhone HEIC upload test page (/upload-test). Each button opens its own
// file input with a different `accept`, so we can see which ones fire onChange on iOS.
const VARIANTS: { letter: string; accept?: string }[] = [
  { letter: "A", accept: "image/*" },
  { letter: "B" },
  { letter: "C", accept: "image/heic,image/heif" },
  { letter: "D", accept: ".heic,.heif,.jpg,.jpeg,.png,.webp" },
  { letter: "E", accept: "*/*" },
  { letter: "F", accept: "image/*,.heic,.heif" },
];

type LogEntry = { id: number; text: string; thumbUrl?: string };

function kb(bytes: number) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export function UploadTestPage() {
  const [log, setLog] = useState<LogEntry[]>([]);
  const inputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const nextId = useRef(0);
  const thumbUrls = useRef<string[]>([]);

  useEffect(() => {
    const urls = thumbUrls.current;
    return () => urls.forEach((url) => URL.revokeObjectURL(url));
  }, []);

  function addLog(text: string, thumbUrl?: string) {
    const id = nextId.current++;
    setLog((prev) => [...prev, { id, text, thumbUrl }]);
  }

  function clearLog() {
    thumbUrls.current.forEach((url) => URL.revokeObjectURL(url));
    thumbUrls.current.length = 0;
    setLog([]);
  }

  function handleClick(letter: string) {
    addLog(`${letter}: clicked`);
    inputRefs.current[letter]?.click();
  }

  async function handleChange(letter: string, event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) {
      addLog(`${letter}: onChange fired — NO FILE`);
      return;
    }
    addLog(`${letter}: onChange fired — ${file.name} ${file.type || "EMPTY"} ${kb(file.size)}`);
    try {
      const jpeg = await normalizeToJpeg(file);
      const url = URL.createObjectURL(jpeg);
      thumbUrls.current.push(url);
      addLog(`${letter}: converted OK ${kb(jpeg.size)}`, url);
    } catch (err) {
      addLog(`${letter}: convert FAIL ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return (
    <main className="screen" style={{ padding: 16 }}>
      <h1 style={{ fontSize: 20, marginBottom: 12 }}>Upload test (temporary)</h1>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        {VARIANTS.map(({ letter, accept }) => (
          <div key={letter} style={{ position: "relative" }}>
            <button
              type="button"
              onClick={() => handleClick(letter)}
              style={{ width: "100%", minHeight: 72, padding: 12, fontSize: 16, fontWeight: 600 }}
            >
              {letter}
              <br />
              <span style={{ fontSize: 12, fontWeight: 400 }}>
                {accept === undefined ? "(no accept)" : `accept="${accept}"`}
              </span>
            </button>
            <input
              ref={(el) => {
                inputRefs.current[letter] = el;
              }}
              type="file"
              className="visually-hidden-input"
              {...(accept === undefined ? {} : { accept })}
              onChange={(event) => void handleChange(letter, event)}
            />
          </div>
        ))}
      </div>

      <button type="button" onClick={clearLog} style={{ marginTop: 16, padding: "10px 16px", fontSize: 15 }}>
        Clear log
      </button>

      <ol style={{ marginTop: 12, paddingLeft: 20, fontFamily: "monospace", fontSize: 13, wordBreak: "break-all" }}>
        {log.map((entry) => (
          <li key={entry.id} style={{ marginBottom: 6 }}>
            {entry.text}
            {entry.thumbUrl ? (
              <img
                src={entry.thumbUrl}
                alt=""
                style={{ display: "block", marginTop: 4, width: 72, height: 72, objectFit: "cover" }}
              />
            ) : null}
          </li>
        ))}
      </ol>
    </main>
  );
}
