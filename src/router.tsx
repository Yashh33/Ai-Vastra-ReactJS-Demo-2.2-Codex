import { Navigate, Route, Routes } from "react-router-dom";

import { AppShell } from "./components/AppShell";
import { ProtectedRoute } from "./components/ProtectedRoute";
import { CatalogPage } from "./pages/CatalogPage";
import { CarouselPage } from "./pages/CarouselPage";
import { FabricSiloPage } from "./pages/FabricSiloPage";
import { GeneratePage } from "./pages/GeneratePage";
import { HomePage } from "./pages/HomePage";
import { LoginPage } from "./pages/LoginPage";
import { MatchColorPage } from "./pages/MatchColorPage";
import { OutputHistoryPage } from "./pages/OutputHistoryPage";
import { OutputViewerPage } from "./pages/OutputViewerPage";

export function AppRouter() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />

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
  );
}
