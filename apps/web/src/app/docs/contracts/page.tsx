import { permanentRedirect } from "next/navigation";

/** The footer and older links point at `/docs/contracts`; the page lives at its full slug. */
export default function ContractsRedirect() {
  permanentRedirect("/docs/contracts-and-addresses");
}
