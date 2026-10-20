"use client";

import { useState } from "react";

/** Opens the phone's share sheet where there is one, otherwise copies the link. */
export function ShareButton({ title }: { title: string }) {
  const [copied, setCopied] = useState(false);

  async function share() {
    const url = window.location.href;
    if (navigator.share) {
      // Dismissing the share sheet rejects; that's not an error worth showing.
      await navigator.share({ title, url }).catch(() => {});
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt("Copy this link", url);
    }
  }

  return (
    <button type="button" className="secondary" onClick={share}>
      {copied ? "Link copied" : "Share"}
    </button>
  );
}
