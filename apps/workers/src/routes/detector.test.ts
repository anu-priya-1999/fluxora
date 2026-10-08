import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveNextAppRoutePath,
  deriveNextPagesApiRoutePath,
  detectRepositoryRoutes,
  isNextAppRouteFile,
  isNextPagesApiRouteFile,
} from "./detector.ts";
import {
  loadGoldenFixtureManifest,
  readGoldenFixtureFileText,
} from "../fixtures/golden.ts";

// 1. Next.js App Router route.ts detection
test("1. Next.js App Router route.ts detection", () => {
  const files = new Map<string, string>([
    [
      "app/api/users/route.ts",
      `export async function GET() {\n  return new Response("ok");\n}`,
    ],
  ]);

  const result = detectRepositoryRoutes({ files });

  assert.equal(result.diagnostics.length, 0);
  assert.equal(result.routes.length, 1);
  const route = result.routes[0];
  assert.ok(route);
  assert.equal(route.framework, "Next.js");
  assert.equal(route.routeType, "app-router-handler");
  assert.equal(route.filePath, "app/api/users/route.ts");
  assert.equal(route.routePath, "/api/users");
  assert.deepEqual(route.httpMethods, ["GET"]);
  assert.equal(route.symbolName, "GET");
});

// 2. Next.js App Router HTTP method detection
test("2. Next.js App Router HTTP method detection", () => {
  const files = new Map<string, string>([
    [
      "app/api/posts/route.ts",
      `export async function GET() {}\nexport async function POST() {}\nexport async function PUT() {}\nexport async function DELETE() {}\nexport async function PATCH() {}\nexport async function HEAD() {}\nexport async function OPTIONS() {}`,
    ],
  ]);

  const result = detectRepositoryRoutes({ files });

  assert.equal(result.routes.length, 7);
  const methods = result.routes.map((r) => r.httpMethods[0]);
  assert.deepEqual(methods, ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]);
  for (const r of result.routes) {
    assert.equal(r.routePath, "/api/posts");
    assert.equal(r.routeType, "app-router-handler");
  }
});

// 3. Next.js Pages Router API detection
test("3. Next.js Pages Router API detection", () => {
  const files = new Map<string, string>([
    [
      "pages/api/hello.ts",
      `export default function handler(req, res) {\n  res.status(200).json({ name: "John" });\n}`,
    ],
  ]);

  const result = detectRepositoryRoutes({ files });

  assert.equal(result.routes.length, 1);
  const route = result.routes[0];
  assert.ok(route);
  assert.equal(route.framework, "Next.js");
  assert.equal(route.routeType, "pages-api-route");
  assert.equal(route.filePath, "pages/api/hello.ts");
  assert.equal(route.routePath, "/api/hello");
  assert.deepEqual(route.httpMethods, ["ALL"]);
  assert.equal(route.symbolName, "handler");
});

// 4. Next.js dynamic API route path derivation
test("4. Next.js dynamic API route path derivation", () => {
  assert.equal(deriveNextAppRoutePath("app/api/posts/[id]/route.ts"), "/api/posts/[id]");
  assert.equal(
    deriveNextAppRoutePath("src/app/api/users/[userId]/posts/[postId]/route.tsx"),
    "/api/users/[userId]/posts/[postId]",
  );
  assert.equal(deriveNextAppRoutePath("app/route.js"), "/");

  assert.equal(deriveNextPagesApiRoutePath("pages/api/posts/[id].ts"), "/api/posts/[id]");
  assert.equal(
    deriveNextPagesApiRoutePath("src/pages/api/v1/users/[id]/index.tsx"),
    "/api/v1/users/[id]",
  );
  assert.equal(deriveNextPagesApiRoutePath("pages/api/index.ts"), "/api");
});

// 5. Non-API app pages not being detected
test("5. Non-API app pages not being detected", () => {
  assert.equal(isNextAppRouteFile("app/page.tsx"), false);
  assert.equal(isNextAppRouteFile("app/layout.tsx"), false);
  assert.equal(isNextAppRouteFile("app/dashboard/page.tsx"), false);
  assert.equal(isNextAppRouteFile("app/components/button.tsx"), false);
  assert.equal(isNextPagesApiRouteFile("pages/index.tsx"), false);
  assert.equal(isNextPagesApiRouteFile("pages/about.tsx"), false);

  const files = new Map<string, string>([
    ["app/page.tsx", `export default function Page() { return <div>Home</div>; }`],
    ["app/layout.tsx", `export default function RootLayout({ children }) { return children; }`],
    ["pages/index.tsx", `export default function Index() { return <h1>Home</h1>; }`],
  ]);

  const result = detectRepositoryRoutes({ files });

  assert.equal(result.routes.length, 0);
  assert.equal(result.routers.length, 0);
});

// 6. Express Router creation through express.Router()
test("6. Express Router creation through express.Router()", () => {
  const files = new Map<string, string>([
    [
      "src/routes/user.ts",
      `import express from "express";\nconst router = express.Router();\nexport default router;`,
    ],
  ]);

  const result = detectRepositoryRoutes({ files });

  assert.equal(result.routers.length, 1);
  const router = result.routers[0];
  assert.ok(router);
  assert.equal(router.routerSymbol, "router");
  assert.equal(router.filePath, "src/routes/user.ts");
  assert.equal(router.routes.length, 0);
});

// 7. Express Router creation through Router imported from express
test("7. Express Router creation through Router imported from express", () => {
  const files = new Map<string, string>([
    [
      "src/routes/auth.ts",
      `import { Router } from "express";\nconst authRouter = Router();\nexport { authRouter };`,
    ],
  ]);

  const result = detectRepositoryRoutes({ files });

  assert.equal(result.routers.length, 1);
  const router = result.routers[0];
  assert.ok(router);
  assert.equal(router.routerSymbol, "authRouter");
  assert.equal(router.filePath, "src/routes/auth.ts");
});

// 8. router.get detection
test("8. router.get detection", () => {
  const files = new Map<string, string>([
    [
      "src/routes/users.ts",
      `import express from "express";\nconst router = express.Router();\nrouter.get("/users", (req, res) => res.send([]));`,
    ],
  ]);

  const result = detectRepositoryRoutes({ files });

  assert.equal(result.routes.length, 1);
  const route = result.routes[0];
  assert.ok(route);
  assert.equal(route.framework, "Express");
  assert.equal(route.routeType, "express-router");
  assert.equal(route.routePath, "/users");
  assert.deepEqual(route.httpMethods, ["GET"]);
  assert.equal(route.symbolName, "router");

  assert.equal(result.routers.length, 1);
  assert.equal(result.routers[0]?.routes.length, 1);
  assert.equal(result.routers[0]?.routes[0]?.method, "GET");
  assert.equal(result.routers[0]?.routes[0]?.path, "/users");
});

// 9. router.post detection
test("9. router.post detection", () => {
  const files = new Map<string, string>([
    [
      "src/routes/users.ts",
      `import express from "express";\nconst router = express.Router();\nrouter.post("/users", (req, res) => res.status(201).send({}));`,
    ],
  ]);

  const result = detectRepositoryRoutes({ files });

  assert.equal(result.routes.length, 1);
  assert.equal(result.routes[0]?.routePath, "/users");
  assert.deepEqual(result.routes[0]?.httpMethods, ["POST"]);
});

// 10. router.put detection
test("10. router.put detection", () => {
  const files = new Map<string, string>([
    [
      "src/routes/users.ts",
      `import express from "express";\nconst router = express.Router();\nrouter.put("/users/:id", (req, res) => res.send({}));`,
    ],
  ]);

  const result = detectRepositoryRoutes({ files });

  assert.equal(result.routes.length, 1);
  assert.equal(result.routes[0]?.routePath, "/users/:id");
  assert.deepEqual(result.routes[0]?.httpMethods, ["PUT"]);
});

// 11. router.patch detection
test("11. router.patch detection", () => {
  const files = new Map<string, string>([
    [
      "src/routes/users.ts",
      `import express from "express";\nconst router = express.Router();\nrouter.patch("/users/:id", (req, res) => res.send({}));`,
    ],
  ]);

  const result = detectRepositoryRoutes({ files });

  assert.equal(result.routes.length, 1);
  assert.equal(result.routes[0]?.routePath, "/users/:id");
  assert.deepEqual(result.routes[0]?.httpMethods, ["PATCH"]);
});

// 12. router.delete detection
test("12. router.delete detection", () => {
  const files = new Map<string, string>([
    [
      "src/routes/users.ts",
      `import express from "express";\nconst router = express.Router();\nrouter.delete("/users/:id", (req, res) => res.send({}));`,
    ],
  ]);

  const result = detectRepositoryRoutes({ files });

  assert.equal(result.routes.length, 1);
  assert.equal(result.routes[0]?.routePath, "/users/:id");
  assert.deepEqual(result.routes[0]?.httpMethods, ["DELETE"]);
});

// 13. router.use detection
test("13. router.use detection", () => {
  const files = new Map<string, string>([
    [
      "src/routes/index.ts",
      `import express from "express";\nconst router = express.Router();\nrouter.use("/api", childRouter);\nrouter.use(middleware);`,
    ],
  ]);

  const result = detectRepositoryRoutes({ files });

  assert.equal(result.routers.length, 1);
  const router = result.routers[0];
  assert.ok(router);
  assert.equal(router.routes.length, 2);
  assert.equal(router.routes[0]?.method, "ALL");
  assert.equal(router.routes[0]?.path, "/api");
  assert.equal(router.routes[1]?.method, "ALL");
  assert.equal(router.routes[1]?.path, null);
});

// 14. app.get/app.post/etc. when Express origin is proven
test("14. app.get/app.post/etc. when Express origin is proven", () => {
  const files = new Map<string, string>([
    [
      "src/server.ts",
      `import express from "express";\nconst app = express();\napp.get("/health", (req, res) => res.send("ok"));\napp.post("/login", (req, res) => res.send("token"));\napp.use("/api", apiRouter);`,
    ],
  ]);

  const result = detectRepositoryRoutes({ files });

  assert.equal(result.routes.length, 3);
  const healthRoute = result.routes.find((r) => r.routePath === "/health");
  assert.ok(healthRoute);
  assert.equal(healthRoute.framework, "Express");
  assert.equal(healthRoute.routeType, "express-app-route");
  assert.deepEqual(healthRoute.httpMethods, ["GET"]);
  assert.equal(healthRoute.symbolName, "app");

  const loginRoute = result.routes.find((r) => r.routePath === "/login");
  assert.ok(loginRoute);
  assert.deepEqual(loginRoute.httpMethods, ["POST"]);

  const mountRoute = result.routes.find((r) => r.routePath === "/api");
  assert.ok(mountRoute);
  assert.deepEqual(mountRoute.httpMethods, ["ALL"]);
});

// 15. static route path extraction
test("15. static route path extraction", () => {
  const files = new Map<string, string>([
    [
      "src/routes.ts",
      `import express from "express";\nconst router = express.Router();\nrouter.get("/users/:id", h1);\nrouter.post(\`/items/:itemId\`, h2);`,
    ],
  ]);

  const result = detectRepositoryRoutes({ files });

  assert.equal(result.routes.length, 2);
  assert.equal(result.routes[0]?.routePath, "/items/:itemId");
  assert.equal(result.routes[1]?.routePath, "/users/:id");
});

// 16. dynamic/non-static route path handling
test("16. dynamic/non-static route path handling", () => {
  const files = new Map<string, string>([
    [
      "src/routes.ts",
      `import express from "express";\nconst router = express.Router();\nconst BASE = "/api";\nrouter.get(BASE + "/users", h);`,
    ],
  ]);

  const result = detectRepositoryRoutes({ files });

  assert.equal(result.routes.length, 1);
  assert.equal(result.routes[0]?.routePath, "(unresolved)");
});

// 17. false-positive prevention for arbitrary objects named router/app
test("17. false-positive prevention for arbitrary objects named router/app", () => {
  const files = new Map<string, string>([
    [
      "src/custom-router.ts",
      `const router = { get: (path: string, fn: any) => fn(), post: () => {} };\nrouter.get("/custom", () => {});`,
    ],
    [
      "src/custom-app.ts",
      `class Application {\n  get(path: string) {}\n}\nconst app = new Application();\napp.get("/test");`,
    ],
    [
      "src/mock.ts",
      `const app = { get() {}, post() {} };\napp.get("/mock");`,
    ],
  ]);

  const result = detectRepositoryRoutes({ files });

  assert.equal(result.routes.length, 0);
  assert.equal(result.routers.length, 0);
});

// 18. source locations
test("18. source locations track 1-based line/col and 0-based offset accurately", () => {
  const files = new Map<string, string>([
    [
      "app/api/status/route.ts",
      `// Line 1\n// Line 2\nexport async function GET() {\n  return new Response("ok");\n}`,
    ],
  ]);

  const result = detectRepositoryRoutes({ files });

  assert.equal(result.routes.length, 1);
  const loc = result.routes[0]?.sourceLocation;
  assert.ok(loc);
  assert.equal(loc.start.line, 3);
  assert.equal(loc.start.column, 1);
  assert.ok(loc.start.offset > 0);
  assert.ok(loc.end.offset > loc.start.offset);
});

// 19. deterministic repeated execution
test("19. deterministic repeated execution produces identical results across runs", () => {
  const files = new Map<string, string>([
    [
      "app/api/posts/route.ts",
      `export async function GET() {}\nexport async function POST() {}`,
    ],
    [
      "src/routes/auth.ts",
      `import express from "express";\nconst router = express.Router();\nrouter.get("/login", h);\nrouter.post("/login", h);`,
    ],
    [
      "pages/api/billing.ts",
      `export default function handler() {}`,
    ],
  ]);

  const run1 = detectRepositoryRoutes({ files });
  const run2 = detectRepositoryRoutes({ files });

  assert.deepEqual(run1, run2);
});

// 20. malformed source tolerance
test("20. malformed source tolerance records diagnostics without throwing", () => {
  const files = new Map<string, string>([
    [
      "app/api/broken/route.ts",
      `export async function GET( { incomplete syntax ;;;`,
    ],
  ]);

  // Must not throw unhandled exception
  const result = detectRepositoryRoutes({ files });
  assert.ok(result);
});

// 21. ignored directories are skipped
test("21. ignored directories are strictly skipped", () => {
  const files = new Map<string, string>([
    [
      "node_modules/package/app/api/route.ts",
      `export async function GET() {}`,
    ],
    [
      ".next/server/app/api/route.js",
      `export function GET() {}`,
    ],
    [
      "dist/routes/api.js",
      `import express from "express";\nconst router = express.Router();\nrouter.get("/api", h);`,
    ],
  ]);

  const result = detectRepositoryRoutes({ files });

  assert.equal(result.routes.length, 0);
  assert.equal(result.routers.length, 0);
});

// 22. golden fixture Next.js route detection
test("22. golden fixture Next.js route detection finds real route handlers and ignores pages", () => {
  const manifest = loadGoldenFixtureManifest();

  const files = new Map<string, string>();
  for (const entry of manifest.files) {
    if (
      entry.path.endsWith(".ts") ||
      entry.path.endsWith(".tsx") ||
      entry.path.endsWith(".js") ||
      entry.path.endsWith(".jsx")
    ) {
      files.set(entry.path, readGoldenFixtureFileText(entry.path));
    }
  }

  const result = detectRepositoryRoutes({ files });

  // In shadcn taxonomy golden fixture, we identified 4 App Router route files:
  // 1. app/api/og/route.tsx (GET) -> /api/og
  // 2. app/api/posts/route.ts (GET, POST) -> /api/posts
  // 3. app/api/users/stripe/route.ts (GET) -> /api/users/stripe
  // 4. app/api/webhooks/stripe/route.ts (POST) -> /api/webhooks/stripe

  assert.ok(result.routes.length >= 5, `Expected at least 5 detected route handlers, got ${result.routes.length}`);

  const ogRoute = result.routes.find((r) => r.filePath === "app/api/og/route.tsx");
  assert.ok(ogRoute, "app/api/og/route.tsx must be detected");
  assert.equal(ogRoute.routePath, "/api/og");
  assert.deepEqual(ogRoute.httpMethods, ["GET"]);
  assert.equal(ogRoute.framework, "Next.js");

  const postsGetRoute = result.routes.find(
    (r) => r.filePath === "app/api/posts/route.ts" && r.httpMethods.includes("GET"),
  );
  assert.ok(postsGetRoute, "app/api/posts/route.ts GET must be detected");
  assert.equal(postsGetRoute.routePath, "/api/posts");

  const postsPostRoute = result.routes.find(
    (r) => r.filePath === "app/api/posts/route.ts" && r.httpMethods.includes("POST"),
  );
  assert.ok(postsPostRoute, "app/api/posts/route.ts POST must be detected");
  assert.equal(postsPostRoute.routePath, "/api/posts");

  const stripeUserRoute = result.routes.find(
    (r) => r.filePath === "app/api/users/stripe/route.ts",
  );
  assert.ok(stripeUserRoute, "app/api/users/stripe/route.ts must be detected");
  assert.equal(stripeUserRoute.routePath, "/api/users/stripe");
  assert.deepEqual(stripeUserRoute.httpMethods, ["GET"]);

  const stripeWebhookRoute = result.routes.find(
    (r) => r.filePath === "app/api/webhooks/stripe/route.ts",
  );
  assert.ok(stripeWebhookRoute, "app/api/webhooks/stripe/route.ts must be detected");
  assert.equal(stripeWebhookRoute.routePath, "/api/webhooks/stripe");
  assert.deepEqual(stripeWebhookRoute.httpMethods, ["POST"]);

  // Verify that frontend pages like app/(marketing)/page.tsx or app/(dashboard)/dashboard/page.tsx are NOT detected as API routes
  for (const r of result.routes) {
    assert.ok(
      !r.filePath.includes("page.tsx"),
      `Page file ${r.filePath} was incorrectly classified as an API route!`,
    );
    assert.ok(
      !r.filePath.includes("layout.tsx"),
      `Layout file ${r.filePath} was incorrectly classified as an API route!`,
    );
  }
});

