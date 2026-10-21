import { apiFile } from "../../../lib/api";

/** The guardian's copy of the waivers they signed, using their signing link's token. */
export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get("token");
  if (!token) return new Response("Not found", { status: 404 });
  return apiFile("/public/guardian-signatures/waivers.pdf", { method: "POST", body: { token } });
}
