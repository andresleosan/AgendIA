import type { MetadataRoute } from "next";

export const dynamic = "force-static";

export default function sitemap(): MetadataRoute.Sitemap {
  return [{ url: "https://agendia-app.pages.dev/", changeFrequency: "monthly", priority: 1 }];
}
