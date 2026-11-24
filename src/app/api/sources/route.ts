import { ALL_SOURCES, SUPER_SOURCES } from "@/lib/types";

// Public (no auth): lets the native apps read the source lists instead of copying them.
export function GET() {
  return Response.json(
    { standard: ALL_SOURCES, super: SUPER_SOURCES },
    { headers: { "Cache-Control": "public, max-age=300, s-maxage=300" } }
  );
}
