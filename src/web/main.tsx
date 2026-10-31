import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { Shell } from "./components";
import { usePath } from "./router";
import { DropPage, Home, MePage, ReturnPage } from "./pages/public";
import { SellerPage } from "./pages/seller";
import { AgentPage, EvalsPage, HowPage, JudgePage, VerifyPage } from "./pages/misc";

function App() {
  const { path, query } = usePath();
  const seg = path.split("/").filter(Boolean);
  let page;
  if (seg[0] === "d" && seg[1]) page = <DropPage slug={seg[1]} />;
  else if (seg[0] === "seller" && seg[1]) page = <SellerPage slug={seg[1]} sellerKey={query.get("k") ?? ""} />;
  else if (seg[0] === "verify" && seg[1]) page = <VerifyPage slug={seg[1]} />;
  else if (seg[0] === "me" && seg[1]) page = <MePage entryId={seg[1]} />;
  else if (seg[0] === "return") page = <ReturnPage entryId={query.get("entry") ?? ""} cancelled={query.get("cancelled") === "1"} />;
  else if (seg[0] === "agent") page = <AgentPage />;
  else if (seg[0] === "evals") page = <EvalsPage />;
  else if (seg[0] === "judge") page = <JudgePage />;
  else if (seg[0] === "how") page = <HowPage />;
  else page = <Home />;
  return <Shell>{page}</Shell>;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
