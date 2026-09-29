import { auth } from "@clerk/nextjs/server";
import { UserButton } from "@clerk/nextjs";

export default async function DashboardPage() {
  const { userId, isAuthenticated } = await auth();

  if (!isAuthenticated) {
    return null;
  }

  return (
    <main>
      <header>
        <h1>Fluxora</h1>
        <UserButton />
      </header>

      <section>
        <h2>Organization Dashboard</h2>
        <p>Your Fluxora workspace is ready.</p>
        <p>User ID: {userId}</p>
        <p>No repositories connected yet.</p>
      </section>
    </main>
  );
}
