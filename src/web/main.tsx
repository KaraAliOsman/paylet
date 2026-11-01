import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import "./console.css";
import { Shell } from "./components";
import { usePath } from "./router";
import { DropPage, MePage, NotFound, ReturnPage } from "./pages/public";
import { Home } from "./pages/home";
import { SellerPage } from "./pages/seller";
import { AgentPage } from "./pages/agent";
import { HowPage } from "./pages/how";
import { VerifyPage } from "./pages/verify";
import { EvalsPage, JudgePage } from "./pages/misc";

function App() {
  const { path, query } = usePath();
  const seg = path.split("/").filter(Boolean);
  let page;
  if (seg.length === 0) page = <Home />;
  else if (seg[0] === "d" && seg[1]) page = <DropPage slug={seg[1]} />;
  else if (seg[0] === "seller" && seg[1]) page = <SellerPage key={seg[1]} slug={seg[1]} />;
  else if (seg[0] === "verify" && seg[1]) page = <VerifyPage slug={seg[1]} />;
  else if (seg[0] === "me" && seg[1]) page = <MePage entryId={seg[1]} />;
  else if (seg[0] === "return") page = <ReturnPage entryId={query.get("entry") ?? ""} cancelled={query.get("cancelled") === "1"} />;
  else if (seg[0] === "agent" && seg.length === 1) page = <AgentPage key={query.get("drop") ?? ""} />;
  else if (seg[0] === "evals" && seg.length === 1) page = <EvalsPage />;
  else if (seg[0] === "judge" && seg.length === 1) page = <JudgePage />;
  else if (seg[0] === "how" && seg.length === 1) page = <HowPage />;
  else page = <NotFound what="page" />;
  return <Shell>{page}</Shell>;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
