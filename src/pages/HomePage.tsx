import { useNavigate } from "react-router-dom";

export function HomePage() {
  const navigate = useNavigate();

  return (
    <main className="screen screen-fill">
      <section className="page-shell equal-fill-shell equal-fill-shell-3">
        <button className="home-card home-card-visualize equal-fill-card" onClick={() => navigate("/visualize")}>
          <strong>Visualize</strong>
          <span>Select hero image and fabric image, then generate output.</span>
        </button>

        <button className="home-card home-card-hero equal-fill-card" onClick={() => navigate("/hero-folders")}>
          <strong>Hero Image</strong>
          <span>Upload Hero Image</span>
        </button>

        <button className="home-card home-card-history equal-fill-card" onClick={() => navigate("/output-history")}>
          <strong>Output History</strong>
          <span>View output tiles, quick download, and match color.</span>
        </button>
      </section>
    </main>
  );
}
