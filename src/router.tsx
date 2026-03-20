import { Navigate, Route, Routes } from "react-router-dom";

import { ProtectedRoute } from "./components/ProtectedRoute";
import { CatalogFoldersPage } from "./pages/CatalogFoldersPage";
import { CatalogOutputsPage } from "./pages/CatalogOutputsPage";
import { CarouselPage } from "./pages/CarouselPage";
import { HeroFolderDetailPage } from "./pages/HeroFolderDetailPage";
import { HeroFoldersPage } from "./pages/HeroFoldersPage";
import { HomePage } from "./pages/HomePage";
import { LoginPage } from "./pages/LoginPage";
import { MatchColorPage } from "./pages/MatchColorPage";
import { ModeSelectionPage } from "./pages/ModeSelectionPage";
import { OutputHistoryPage } from "./pages/OutputHistoryPage";
import { OutputViewerPage } from "./pages/OutputViewerPage";
import { VisualizePage } from "./pages/VisualizePage";

export function AppRouter() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />

      <Route element={<ProtectedRoute />}>
        <Route path="/" element={<ModeSelectionPage />} />
        <Route path="/create-looks" element={<HomePage />} />
        <Route path="/catalog" element={<CatalogFoldersPage />} />
        <Route path="/catalog/folders/:folderId" element={<CatalogOutputsPage />} />
        <Route path="/hero-folders" element={<HeroFoldersPage />} />
        <Route path="/hero-folders/:folderId" element={<HeroFolderDetailPage />} />
        <Route path="/visualize" element={<VisualizePage />} />
        <Route path="/output-history" element={<OutputHistoryPage />} />
        <Route path="/output-viewer" element={<OutputViewerPage />} />
        <Route path="/match-color" element={<MatchColorPage />} />
        <Route path="/carousel" element={<CarouselPage />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
