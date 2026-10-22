import { apiFile } from "../../../../../../../../lib/api";

/** The buyer's copy of a ticket's signed waivers, using the order link's key. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ orderId: string; ticketId: string }> },
) {
  const { orderId, ticketId } = await params;
  const key = new URL(request.url).searchParams.get("key");
  if (!key) return new Response("Not found", { status: 404 });
  return apiFile(
    `/public/orders/${encodeURIComponent(orderId)}/tickets/${encodeURIComponent(ticketId)}/waivers.pdf`,
    { method: "POST", body: { key } },
  );
}
