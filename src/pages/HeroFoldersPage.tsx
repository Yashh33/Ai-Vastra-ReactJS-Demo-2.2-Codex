import { FormEvent, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import { apiFetch } from "../lib/api";
import { useAuth } from "../lib/auth";
import type { FolderRow } from "../lib/types";
import { formatDateLabel, truncateText } from "../lib/utils";

export function HeroFoldersPage() {
  const { accessToken } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const pickerMode = useMemo(() => {
    const value = searchParams.get("picker");
    return value === "1" || value === "true";
  }, [searchParams]);

  const [folders, setFolders] = useState<FolderRow[]>([]);
  const [includeInactive, setIncludeInactive] = useState(true);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [statusText, setStatusText] = useState("Loading folders...");

  const [name, setName] = useState("");
  const [promptTemplate, setPromptTemplate] = useState("");

  async function loadFolders() {
    if (!accessToken) return;
    setLoading(true);
    try {
      const rows = await apiFetch<FolderRow[]>(
        `/folders?include_inactive=${includeInactive ? "true" : "false"}`,
        accessToken,
        { method: "GET" }
      );

      setFolders(rows);
      setStatusText(rows.length ? `Loaded ${rows.length} folder(s)` : "No folders yet");
    } catch (err) {
      setStatusText(`Failed to load folders: ${err instanceof Error ? err.message : "Unknown error"}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadFolders();
  }, [accessToken, includeInactive]);

  async function onCreateFolder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!accessToken) return;
    if (!name.trim()) {
      setStatusText("Folder name is required");
      return;
    }

    setCreating(true);
    try {
      await apiFetch<FolderRow>("/folders", accessToken, {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          prompt_template: promptTemplate.trim()
        })
      });

      setName("");
      setPromptTemplate("");
      setStatusText("Folder created");
      await loadFolders();
    } catch (err) {
      setStatusText(`Create failed: ${err instanceof Error ? err.message : "Unknown error"}`);
    } finally {
      setCreating(false);
    }
  }

  function openFolder(folderId: string) {
    const query = pickerMode ? "?picker=1" : "";
    navigate(`/hero-folders/${folderId}${query}`);
  }

  return (
    <main className="screen">
      <section className="page-shell">
        <header className="page-header">
          <div>
            <h1>{pickerMode ? "Select Hero Folder" : "Hero Folders"}</h1>
            <p className="muted">
              {pickerMode
                ? "Pick a folder, then choose a hero image for Visualize."
                : "Create folders and open a folder to manage hero images."}
            </p>
          </div>
          <button className="btn btn-light" onClick={() => navigate(-1)}>
            Back
          </button>
        </header>

        <section className="card stack-sm">
          <h2>Create Folder</h2>
          <form className="stack-sm" onSubmit={onCreateFolder}>
            <label className="field">
              <span>Folder name</span>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="e.g. Saree, Suit, Shirt"
                disabled={creating}
              />
            </label>
            <label className="field">
              <span>Prompt template (optional)</span>
              <textarea
                value={promptTemplate}
                onChange={(event) => setPromptTemplate(event.target.value)}
                placeholder="Category-specific prompt instructions"
                rows={4}
                disabled={creating}
              />
            </label>
            <button className="btn btn-dark" type="submit" disabled={creating}>
              {creating ? "Creating..." : "Create Folder"}
            </button>
          </form>
        </section>

        <section className="card stack-sm">
          <div className="between">
            <h2>Folders</h2>
            <div className="row">
              <label className="switch-row">
                <input
                  type="checkbox"
                  checked={includeInactive}
                  onChange={(event) => setIncludeInactive(event.target.checked)}
                />
                <span>Show inactive</span>
              </label>
              <button className="btn btn-light" onClick={loadFolders} disabled={loading}>
                {loading ? "Refreshing..." : "Refresh"}
              </button>
            </div>
          </div>

          <p className="tiny muted">{statusText}</p>

          {loading ? (
            <div className="loading-box">
              <div className="spinner" />
            </div>
          ) : folders.length === 0 ? (
            <div className="empty-box">No folders found.</div>
          ) : (
            <div className="tile-grid">
              {folders.map((folder) => (
                <button
                  key={folder.id}
                  className={`folder-tile ${folder.is_active ? "" : "folder-tile-inactive"}`}
                  onClick={() => openFolder(folder.id)}
                >
                  <div className="folder-icon" aria-hidden />
                  <strong>{folder.name}</strong>
                  <span className="tiny muted">{folder.is_active ? "Active" : "Inactive"}</span>
                  <span className="tiny muted">{formatDateLabel(folder.created_at)}</span>
                  {folder.prompt_template ? (
                    <span className="tiny muted">{truncateText(folder.prompt_template, 90)}</span>
                  ) : (
                    <span className="tiny muted">(No prompt template)</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </section>
      </section>
    </main>
  );
}
