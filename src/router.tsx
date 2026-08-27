import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";

import { AppShell } from "./components/AppShell";
import { ProtectedRoute } from "./components/ProtectedRoute";

const CatalogPage = lazy(() => import("./pages/CatalogPage").then((m) => ({ default: m.CatalogPage })));
const CarouselPage = lazy(() => import("./pages/CarouselPage").then((m) => ({ default: m.CarouselPage })));
const FabricSiloPage = lazy(() => import("./pages/FabricSiloPage").then((m) => ({ default: m.FabricSiloPage })));
const GeneratePage = lazy(() => import("./pages/GeneratePage").then((m) => ({ default: m.GeneratePage })));
const HomePage = lazy(() => import("./pages/HomePage").then((m) => ({ default: m.HomePage })));
const LoginPage = lazy(() => import("./pages/LoginPage").then((m) => ({ default: m.LoginPage })));
const MatchColorPage = lazy(() => import("./pages/MatchColorPage").then((m) => ({ default: m.MatchColorPage })));
const OutputHistoryPage = lazy(() =>
  import("./pages/OutputHistoryPage").then((m) => ({ default: m.OutputHistoryPage }))
);
const OutputViewerPage = lazy(() =>
  import("./pages/OutputViewerPage").then((m) => ({ default: m.OutputViewerPage }))
);
const ScreenPage = lazy(() => import("./pages/ScreenPage").then((m) => ({ default: m.ScreenPage })));

function RouteFallback() {
  return (
    <main className="screen screen-centered">
      <div className="spinner" aria-label="Loading" />
    </main>
  );
}

export function AppRouter() {
  return (
    <Suspense fallback={<RouteFallback />}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/screen/:shopId" element={<ScreenPage />} />

        <Route element={<ProtectedRoute />}>
          <Route element={<AppShell />}>
            <Route path="/" element={<HomePage />} />
            <Route path="/create-looks" element={<HomePage />} />
            <Route path="/generate" element={<GeneratePage />} />
            <Route path="/catalog" element={<CatalogPage />} />
            <Route path="/fabric-silo" element={<FabricSiloPage />} />
            <Route path="/output-history" element={<OutputHistoryPage />} />
            <Route path="/output-viewer" element={<OutputViewerPage />} />
            <Route path="/match-color" element={<MatchColorPage />} />
            <Route path="/carousel" element={<CarouselPage />} />
          </Route>
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}
