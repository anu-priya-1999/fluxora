# Fluxora — Phase 1, Step 4 Learning
## Next.js App Router + Clerk Authentication UI

Step 4 is complete and tested.

## 1. What Step 4 added

`apps/web` was converted from the original workspace shell into a real Next.js App Router application with Clerk authentication.

Flow:

Browser
→ Next.js App Router
→ Clerk
→ GitHub sign-in
→ authenticated session
→ Fluxora dashboard

Fluxora's PostgreSQL `Organization` remains the product tenant model. Clerk handles authentication, not Fluxora organization membership or roles.

## 2. App Router basics

Routes live under:

`apps/web/src/app/`

Examples:

`src/app/page.tsx` → `/`

`src/app/login/page.tsx` → `/login`

`src/app/dashboard/page.tsx` → `/dashboard`

`layout.tsx` provides a shared layout around descendant routes.

## 3. Next.js route patterns — important interview reference

```text
/foo
     = exact route

/[id]
     = one dynamic segment

/[...parts]
     = one or more dynamic segments

/[[...parts]]
     = zero or more dynamic segments
```

### Exact route

```text
app/foo/page.tsx
```

matches `/foo`.

### Dynamic segment

```text
app/[id]/page.tsx
```

matches one dynamic value such as `/123` or `/abc`.

### Catch-all segment

```text
app/[...parts]/page.tsx
```

matches one or more segments:

`/foo`

`/foo/bar`

`/foo/bar/baz`

### Optional catch-all segment

```text
app/[[...parts]]/page.tsx
```

matches zero or more segments:

`/`

`/foo`

`/foo/bar`

## 4. Why Clerk uses `[[...sign-in]]`

Fluxora uses:

```text
apps/web/src/app/sign-in/[[...sign-in]]/page.tsx
```

and:

```text
apps/web/src/app/sign-up/[[...sign-up]]/page.tsx
```

The double brackets make the catch-all segment optional, so the base `/sign-in` route works while Clerk can also handle nested authentication paths.

Key distinction:

`[...sign-in]` = catch-all, required

`[[...sign-in]]` = catch-all, optional

## 5. ClerkProvider

The root layout uses:

```tsx
<html lang="en">
  <body>
    <ClerkProvider>{children}</ClerkProvider>
  </body>
</html>
```

This makes Clerk authentication context available throughout the application tree.

## 6. Clerk v7 UI lesson

The installed Clerk version is `@clerk/nextjs 7.9.7`.

The initial UI used `SignedIn` and `SignedOut`. In this installed/current API we changed the UI to `Show`:

```tsx
<Show when="signed-out">
  <Link href="/login">Sign in</Link>
</Show>

<Show when="signed-in">
  <UserButton />
  <Link href="/dashboard">Open Dashboard</Link>
</Show>
```

General lesson: always check the API for the installed library version rather than copying an older example.

## 7. Login flow

Fluxora exposes `/login` as the application-facing login route.

Flow:

`/login`
→ `/sign-in`
→ Clerk
→ GitHub
→ `/dashboard`

The Clerk `<SignIn />` component uses a redirect destination of `/dashboard`.

Sign-up follows the equivalent path through `/sign-up`.

## 8. Dashboard

The dashboard is a server component and uses Clerk server-side authentication.

Conceptually:

request
→ server auth check
→ authenticated user
→ dashboard

The dashboard is intentionally empty at this stage because repository/product functionality belongs to later roadmap phases.

## 9. Next.js 16 proxy

This project uses Next.js 16.

The Clerk request boundary is:

```text
apps/web/src/proxy.ts
```

rather than the older `middleware.ts` convention.

Conceptually:

Incoming request
→ `proxy.ts`
→ Clerk middleware
→ Next.js route

## 10. Environment variables

The web application uses:

```env
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=...
CLERK_SECRET_KEY=...
```

`NEXT_PUBLIC_*` values may reach browser code.

`CLERK_SECRET_KEY` is server-only and must never be exposed to the client or committed to Git.

Local development file:

```text
apps/web/.env.local
```

## 11. Why Clerk CLI initialization failed

The original `apps/web` package was only a monorepo shell. It had `@clerk/nextjs`, but it did not yet have:

- Next.js
- React
- React DOM
- Next scripts
- an `app/` directory

Therefore `pnpm dlx clerk@latest init` could not detect a framework.

Lesson:

> Installing a framework SDK does not turn a workspace package into a framework application. The runtime and project structure must exist too.

## 12. TypeScript JSX lesson

The first web TypeScript error was:

`Cannot use JSX unless the '--jsx' flag is provided.`

The fix was adding:

```json
"jsx": "preserve"
```

to `apps/web/tsconfig.json`.

## 13. React type declarations

The next issue was:

`JSX element implicitly has type 'any' because no interface 'JSX.IntrinsicElements' exists.`

The web package needed the React/Node type packages:

```text
@types/node
@types/react
@types/react-dom
```

Lesson:

> JSX compiler support and JSX type declarations are separate concerns.

## 14. `next-env.d.ts`

The Next.js generated type reference file lives at:

```text
apps/web/next-env.d.ts
```

not inside `src`.

It is a framework support file, not application business logic.

## 15. Route debugging lesson

We encountered:

`Segment names may not start or end with extra brackets`

The actual issue was an invalid filesystem segment name.

Correct:

```text
[[...sign-in]]
```

Incorrect:

```text
[...sign-in
```

Debugging pattern:

Next.js route error
→ inspect exact folder name
→ compare with App Router syntax
→ correct filesystem structure
→ restart the dev server

## 16. Verification

The final workspace typecheck passed:

```text
packages/shared-types ✅
apps/web             ✅
packages/db          ✅
apps/api             ✅
apps/workers         ✅
```

Command:

```text
pnpm typecheck
```

The web development server also ran successfully and the Clerk/GitHub authentication flow was tested manually.

## 17. What Step 4 accomplished

The complete frontend authentication surface is now:

```text
/
 ↓
/login
 ↓
/sign-in
 ↓
GitHub
 ↓
Clerk session
 ↓
/dashboard
```

This is the intended Step 4 foundation.

## 18. Why Fluxora does not use Clerk Organizations

Clerk Organizations were intentionally not enabled.

Fluxora already owns:

```text
Organization
User
UserRole
organization_id
PostgreSQL RLS
```

The intended responsibility split is:

```text
Clerk
  = authentication

Fluxora
  = organization + role + authorization

PostgreSQL
  = tenant isolation
```

This avoids two competing tenant authorities.

## 19. Step 4 interview concepts

- What is the Next.js App Router?
- What is a dynamic route?
- What is a catch-all route?
- What is an optional catch-all route?
- Why does Clerk use `[[...sign-in]]`?
- Why is `ClerkProvider` in the root layout?
- Why does the dashboard perform server-side auth?
- Why does Fluxora keep its own Organization model instead of using Clerk Organizations?
- Why must secret environment variables stay server-side?

## 20. Core mental model

```text
Next.js App Router
        ↓
      Clerk
        ↓
 authenticated user
        ↓
 Fluxora application
        ↓
 dashboard
```

Routing:

```text
/foo
     = exact route

/[id]
     = one dynamic segment

/[...parts]
     = one or more dynamic segments

/[[...parts]]
     = zero or more dynamic segments
```

## Step 4 status

```text
Step 4 — Next.js + Clerk auth flow/dashboard ✅ COMPLETE
```

Next roadmap target:

```text
Step 5 — Redis + object storage + secrets abstraction
```
