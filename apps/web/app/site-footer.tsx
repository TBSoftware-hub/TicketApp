import Link from "next/link";

/** Links every public page carries, such as the privacy policy the app stores ask for. */
export function SiteFooter() {
  return (
    <footer className="site-footer muted">
      <Link href="/privacy">Privacy policy</Link>
    </footer>
  );
}
