import Link from "next/link";
import { Show, UserButton } from "@clerk/nextjs";

export default function HomePage() {
  return (
    <main>
      <h1>Fluxora</h1>
      <p>AI Software Digital Twin</p>

      <Show when="signed-out">
        <Link href="/login">Sign in</Link>
      </Show>

      <Show when="signed-in">
        <UserButton />

        <div>
          <Link href="/dashboard">Open Dashboard</Link>
        </div>
      </Show>
    </main>
  );
}
