import { useNavigate } from "react-router-dom";

export function HomePage() {
  const navigate = useNavigate();

  return (
    <main className="screen screen-fill">
      <section className="page-shell equal-fill-shell equal-fill-shell-3">
        <button className="home-card home-card-visualize equal-fill-card" onClick={() => navigate("/generate")}>
          <strong>Generate Look</strong>
          <span>Select fabric and garment type, then generate output.</span>
        </button>

        <button className="home-card home-card-hero equal-fill-card" onClick={() => navigate("/catalog")}>
          <strong>Catalog</strong>
          <span>Browse generated looks by garment type.</span>
        </button>

        <button
          className="home-card equal-fill-card"
          style={{ background: "#eee7ff" }}
          onClick={() => navigate("/fabric-silo")}
        >
          <strong>Fabric Silo</strong>
          <span>Add, browse, and reuse saved fabric images.</span>
        </button>
      </section>
    </main>
  );
}
