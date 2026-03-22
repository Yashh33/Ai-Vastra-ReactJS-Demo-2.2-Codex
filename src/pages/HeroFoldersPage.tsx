import { useEffect, useMemo, useState } from "react";
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
  const [statusText, setStatusText] = useState("Loading folders...");

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
      setStatusText(rows.length ? `Loaded ${rows.length} folder(s)` : "No folders found");
    } catch (err) {
      setStatusText(`Failed to load folders: ${err instanceof Error ? err.message : "Unknown error"}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadFolders();
  }, [accessToken, includeInactive]);

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
                : "Open a folder to manage hero images."}
            </p>
          </div>
        </header>

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
              <button className="btn btn-light" onClick={() => void loadFolders()} disabled={loading}>
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

