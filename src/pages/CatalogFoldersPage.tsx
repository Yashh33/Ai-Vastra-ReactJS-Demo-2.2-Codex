import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import { apiFetch } from "../lib/api";
import { useAuth } from "../lib/auth";
import type { FolderRow } from "../lib/types";

function RefreshIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden focusable="false">
      <path
        d="M20 11a8 8 0 1 1-2.34-5.66M20 4v6h-6"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function CatalogFoldersPage() {
  const { accessToken } = useAuth();
  const navigate = useNavigate();

  const [folders, setFolders] = useState<FolderRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [statusText, setStatusText] = useState("Loading folders...");

  async function loadFolders() {
    if (!accessToken) return;
    setLoading(true);
    try {
      const rows = await apiFetch<FolderRow[]>("/folders?include_inactive=false", accessToken, {
        method: "GET"
      });
      setFolders(rows);
      setStatusText(rows.length ? `Loaded ${rows.length} folder(s)` : "No active folders found.");
    } catch (err) {
      setStatusText(`Failed to load folders: ${err instanceof Error ? err.message : "Unknown error"}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadFolders();
  }, [accessToken]);

  function openFolder(folder: FolderRow) {
    const query = new URLSearchParams({ folderName: folder.name });
    navigate(`/catalog/folders/${encodeURIComponent(folder.id)}?${query.toString()}`);
  }

  return (
    <main className="screen catalog-screen">
      <section className="catalog-shell">
        <header className="catalog-header">
          <div className="catalog-header-left">
            <div className="catalog-brand-mark" aria-hidden>
              AV
            </div>

            <div className="catalog-title-wrap">
              <h1 className="catalog-title">Catalog</h1>
              <p className="catalog-subtitle">{folders.length} folders</p>
            </div>
          </div>

          <div className="catalog-header-actions">
            <button className="catalog-icon-btn" onClick={loadFolders} disabled={loading} aria-label="Refresh">
              <RefreshIcon />
            </button>
          </div>
        </header>

        <section className="card stack-sm">
          <p className="tiny muted">{statusText}</p>
          <p className="tiny muted">Tap a folder to view catalog images.</p>
        </section>

        {loading ? (
          <div className="loading-box">
            <div className="spinner" />
          </div>
        ) : folders.length === 0 ? (
          <div className="empty-box">No catalog folders available.</div>
        ) : (
          <section className="tile-grid">
            {folders.map((folder) => (
              <button key={folder.id} className="folder-tile" onClick={() => openFolder(folder)}>
                <div className="folder-icon" aria-hidden />
                <strong>{folder.name}</strong>
                <span className="tiny muted">Tap to view catalog</span>
              </button>
            ))}
          </section>
        )}
      </section>
    </main>
  );
}




