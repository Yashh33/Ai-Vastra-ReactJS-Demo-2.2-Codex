import { useEffect, useState, type ChangeEvent } from "react";

import { ColorStudio } from "../components/ColorStudio";
import { triggerBrowserDownload } from "../lib/download";

type Result = { url: string; sizeKb: number };

function resultFilename(file: File | null) {
  const name = file?.name ?? "image";
  const base = name.includes(".") ? name.slice(0, name.lastIndexOf(".")) : name;
  return `${base || "image"}-corrected.jpg`;
}

/** Test bench for ColorStudio. Everything stays in the browser; nothing is uploaded. */
export function ColorLabPage() {
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  useEffect(() => {
    if (!result) return;
    return () => URL.revokeObjectURL(result.url);
  }, [result]);

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const next = event.target.files?.[0] ?? null;
    event.target.value = "";
    if (!next) return;
    setResult(null);
    setFile(next);
  }

  function handleSave(blob: Blob) {
    setResult({ url: URL.createObjectURL(blob), sizeKb: Math.round(blob.size / 1024) });
  }

  return (
    <main className="screen">
      <section className="page-shell">
        <div className="page-header">
          <h1>Colour Lab</h1>
        </div>

        {!file && (
          <section className="card stack-sm">
            <p className="muted tiny">
              Pick a photo to try the colour-correction tools. The photo stays on this device.
            </p>
            <label className="field">
              Photo
              <input type="file" accept="image/*" onChange={handleFileChange} />
            </label>
          </section>
        )}

        {file && !result && (
          <ColorStudio source={file} onSave={handleSave} onCancel={() => setFile(null)} />
        )}

        {file && result && (
          <section className="card stack-sm">
            <h2>Corrected photo</h2>
            <img
              src={result.url}
              alt="Corrected result"
              style={{ width: "100%", maxHeight: "60svh", objectFit: "contain", borderRadius: 10 }}
            />
            <p className="muted tiny">JPEG, {result.sizeKb} KB</p>
            <button
              type="button"
              className="btn-primary"
              onClick={() => triggerBrowserDownload(result.url, resultFilename(file))}
            >
              Download
            </button>
            <div className="row">
              <button type="button" className="btn-secondary flex-1" onClick={() => setResult(null)}>
                Adjust again
              </button>
              <button
                type="button"
                className="btn-secondary flex-1"
                onClick={() => {
                  setResult(null);
                  setFile(null);
                }}
              >
                New photo
              </button>
            </div>
          </section>
        )}
      </section>
    </main>
  );
}
