import { useNavigate } from "react-router-dom";

export function ModeSelectionPage() {
  const navigate = useNavigate();

  return (
    <main className="screen screen-fill">
      <section className="page-shell equal-fill-shell equal-fill-shell-2">
        <button
          className="mode-card mode-card-create equal-fill-card equal-fill-card-title-only"
          onClick={() => navigate("/create-looks")}
        >
          <strong>Create Looks</strong>
        </button>

        <button
          className="mode-card mode-card-catalog equal-fill-card equal-fill-card-title-only"
          onClick={() => navigate("/catalog")}
        >
          <strong>Catalog</strong>
        </button>
      </section>
    </main>
  );
}
