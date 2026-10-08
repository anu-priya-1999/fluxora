import test from "node:test";
import assert from "node:assert/strict";

import {
  detectRepositoryDatabaseReferences,
  type RepositoryDatabaseDetectionInput,
} from "./detector.ts";
import {
  loadGoldenFixtureManifest,
  readGoldenFixtureFileText,
} from "../fixtures/golden.ts";

test("1. Prisma read: detects prisma.user.findMany(...)", () => {
  const code = `
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
const users = await prisma.user.findMany({ where: { active: true } });
`;
  const input: RepositoryDatabaseDetectionInput = {
    files: new Map([["src/users.ts", code]]),
  };
  const result = detectRepositoryDatabaseReferences(input);

  assert.equal(result.references.length, 1);
  const ref = result.references[0];
  assert.ok(ref);
  assert.equal(ref.family, "prisma");
  assert.equal(ref.operation, "read");
  assert.equal(ref.methodShape, "findMany");
  assert.equal(ref.details.resourceName, "user");
  assert.equal(ref.details.status, "resolved");
  assert.equal(ref.details.receiverSymbol, "prisma");
});

test("2. Prisma create: detects prisma.user.create(...)", () => {
  const code = `
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
await prisma.user.create({ data: { name: "Alice" } });
`;
  const input: RepositoryDatabaseDetectionInput = {
    files: new Map([["src/create-user.ts", code]]),
  };
  const result = detectRepositoryDatabaseReferences(input);

  assert.equal(result.references.length, 1);
  const ref = result.references[0];
  assert.ok(ref);
  assert.equal(ref.family, "prisma");
  assert.equal(ref.operation, "insert");
  assert.equal(ref.methodShape, "create");
  assert.equal(ref.details.resourceName, "user");
  assert.equal(ref.details.status, "resolved");
});

test("3. Prisma update: detects prisma.user.update(...)", () => {
  const code = `
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
await prisma.user.update({ where: { id: "1" }, data: { name: "Bob" } });
`;
  const input: RepositoryDatabaseDetectionInput = {
    files: new Map([["src/update-user.ts", code]]),
  };
  const result = detectRepositoryDatabaseReferences(input);

  assert.equal(result.references.length, 1);
  const ref = result.references[0];
  assert.ok(ref);
  assert.equal(ref.family, "prisma");
  assert.equal(ref.operation, "update");
  assert.equal(ref.methodShape, "update");
  assert.equal(ref.details.resourceName, "user");
});

test("4. Prisma delete: detects prisma.user.delete(...)", () => {
  const code = `
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
await prisma.user.delete({ where: { id: "1" } });
`;
  const input: RepositoryDatabaseDetectionInput = {
    files: new Map([["src/delete-user.ts", code]]),
  };
  const result = detectRepositoryDatabaseReferences(input);

  assert.equal(result.references.length, 1);
  const ref = result.references[0];
  assert.ok(ref);
  assert.equal(ref.family, "prisma");
  assert.equal(ref.operation, "delete");
  assert.equal(ref.methodShape, "delete");
  assert.equal(ref.details.resourceName, "user");
});

test("5. Prisma upsert: detects prisma.user.upsert(...)", () => {
  const code = `
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
await prisma.user.upsert({ where: { email: "a@b.com" }, create: {}, update: {} });
`;
  const input: RepositoryDatabaseDetectionInput = {
    files: new Map([["src/upsert-user.ts", code]]),
  };
  const result = detectRepositoryDatabaseReferences(input);

  assert.equal(result.references.length, 1);
  const ref = result.references[0];
  assert.ok(ref);
  assert.equal(ref.family, "prisma");
  assert.equal(ref.operation, "upsert");
  assert.equal(ref.methodShape, "upsert");
  assert.equal(ref.details.resourceName, "user");
});

test("6. Prisma raw query/execute: detects $queryRaw(...) and $executeRaw(...)", () => {
  const code = `
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
const res1 = await prisma.$queryRaw\`SELECT * FROM users\`;
const res2 = await prisma.$executeRaw\`UPDATE users SET active = true\`;
`;
  const input: RepositoryDatabaseDetectionInput = {
    files: new Map([["src/raw.ts", code]]),
  };
  const result = detectRepositoryDatabaseReferences(input);

  assert.equal(result.references.length, 2);
  const ref1 = result.references[0];
  const ref2 = result.references[1];
  assert.ok(ref1);
  assert.ok(ref2);

  assert.equal(ref1.family, "prisma");
  assert.equal(ref1.operation, "query");
  assert.equal(ref1.methodShape, "$queryRaw");
  assert.equal(ref1.details.resourceName, null);
  assert.equal(ref1.details.status, "resolved");

  assert.equal(ref2.family, "prisma");
  assert.equal(ref2.operation, "execute");
  assert.equal(ref2.methodShape, "$executeRaw");
  assert.equal(ref2.details.resourceName, null);
  assert.equal(ref2.details.status, "resolved");
});

test("7. Drizzle select/from: detects select().from(users)", () => {
  const code = `
import { select } from "drizzle-orm";
import { users } from "./schema";
const result = await select().from(users);
`;
  const input: RepositoryDatabaseDetectionInput = {
    files: new Map([["src/drizzle-select.ts", code]]),
  };
  const result = detectRepositoryDatabaseReferences(input);

  assert.equal(result.references.length, 1);
  const ref = result.references[0];
  assert.ok(ref);
  assert.equal(ref.family, "drizzle");
  assert.equal(ref.operation, "read");
  assert.equal(ref.methodShape, "select");
  assert.equal(ref.details.resourceName, "users");
  assert.equal(ref.details.status, "resolved");
});

test("8. Drizzle insert: detects insert(users)...", () => {
  const code = `
import { insert } from "drizzle-orm";
import { users } from "./schema";
await insert(users).values({ name: "Alice" });
`;
  const input: RepositoryDatabaseDetectionInput = {
    files: new Map([["src/drizzle-insert.ts", code]]),
  };
  const result = detectRepositoryDatabaseReferences(input);

  assert.equal(result.references.length, 1);
  const ref = result.references[0];
  assert.ok(ref);
  assert.equal(ref.family, "drizzle");
  assert.equal(ref.operation, "insert");
  assert.equal(ref.methodShape, "insert");
  assert.equal(ref.details.resourceName, "users");
});

test("9. Drizzle update: detects update(users)...", () => {
  const code = `
import { update } from "drizzle-orm";
import { users } from "./schema";
await update(users).set({ name: "Bob" });
`;
  const input: RepositoryDatabaseDetectionInput = {
    files: new Map([["src/drizzle-update.ts", code]]),
  };
  const result = detectRepositoryDatabaseReferences(input);

  assert.equal(result.references.length, 1);
  const ref = result.references[0];
  assert.ok(ref);
  assert.equal(ref.family, "drizzle");
  assert.equal(ref.operation, "update");
  assert.equal(ref.methodShape, "update");
  assert.equal(ref.details.resourceName, "users");
});

test("10. Drizzle delete: detects delete(users)...", () => {
  const code = `
import { delete as drizzleDelete } from "drizzle-orm";
import { users } from "./schema";
await drizzleDelete(users);
`;
  const input: RepositoryDatabaseDetectionInput = {
    files: new Map([["src/drizzle-delete.ts", code]]),
  };
  const result = detectRepositoryDatabaseReferences(input);

  assert.equal(result.references.length, 1);
  const ref = result.references[0];
  assert.ok(ref);
  assert.equal(ref.family, "drizzle");
  assert.equal(ref.operation, "delete");
  assert.equal(ref.methodShape, "delete");
  assert.equal(ref.details.resourceName, "users");
});

test("11. Drizzle table/resource extraction: detects db.query.users.findMany(...)", () => {
  const code = `
import { drizzle } from "drizzle-orm/node-postgres";
const db = drizzle(client);
const result = await db.query.users.findMany();
`;
  const input: RepositoryDatabaseDetectionInput = {
    files: new Map([["src/drizzle-relational.ts", code]]),
  };
  const result = detectRepositoryDatabaseReferences(input);

  assert.equal(result.references.length, 1);
  const ref = result.references[0];
  assert.ok(ref);
  assert.equal(ref.family, "drizzle");
  assert.equal(ref.operation, "read");
  assert.equal(ref.methodShape, "findMany");
  assert.equal(ref.details.resourceName, "users");
  assert.equal(ref.details.status, "resolved");
});

test("12. TypeORM repository read: detects userRepo.find(...)", () => {
  const code = `
import { getRepository } from "typeorm";
import { User } from "./User";
const userRepo = getRepository(User);
const users = await userRepo.find();
`;
  const input: RepositoryDatabaseDetectionInput = {
    files: new Map([["src/typeorm-repo-read.ts", code]]),
  };
  const result = detectRepositoryDatabaseReferences(input);

  assert.equal(result.references.length, 1);
  const ref = result.references[0];
  assert.ok(ref);
  assert.equal(ref.family, "typeorm");
  assert.equal(ref.operation, "read");
  assert.equal(ref.methodShape, "find");
  assert.equal(ref.details.resourceName, "User");
  assert.equal(ref.details.status, "resolved");
});

test("13. TypeORM repository write: detects userRepo.save(...)", () => {
  const code = `
import { getRepository } from "typeorm";
import { User } from "./User";
const userRepo = getRepository(User);
await userRepo.save(new User());
`;
  const input: RepositoryDatabaseDetectionInput = {
    files: new Map([["src/typeorm-repo-write.ts", code]]),
  };
  const result = detectRepositoryDatabaseReferences(input);

  assert.equal(result.references.length, 1);
  const ref = result.references[0];
  assert.ok(ref);
  assert.equal(ref.family, "typeorm");
  assert.equal(ref.operation, "insert");
  assert.equal(ref.methodShape, "save");
  assert.equal(ref.details.resourceName, "User");
});

test("14. TypeORM EntityManager operation: detects manager.find(User, ...)", () => {
  const code = `
import { EntityManager } from "typeorm";
import { User } from "./User";
async function list(manager: EntityManager) {
  return await manager.find(User);
}
`;
  const input: RepositoryDatabaseDetectionInput = {
    files: new Map([["src/typeorm-em.ts", code]]),
  };
  const result = detectRepositoryDatabaseReferences(input);

  assert.equal(result.references.length, 1);
  const ref = result.references[0];
  assert.ok(ref);
  assert.equal(ref.family, "typeorm");
  assert.equal(ref.operation, "read");
  assert.equal(ref.methodShape, "find");
  assert.equal(ref.details.resourceName, "User");
});

test("15. TypeORM getRepository(entity) operation: detects getRepository(User).findOne(...)", () => {
  const code = `
import { getRepository } from "typeorm";
import { User } from "./User";
const user = await getRepository(User).findOne({ where: { id: 1 } });
`;
  const input: RepositoryDatabaseDetectionInput = {
    files: new Map([["src/typeorm-inline.ts", code]]),
  };
  const result = detectRepositoryDatabaseReferences(input);

  assert.equal(result.references.length, 1);
  const ref = result.references[0];
  assert.ok(ref);
  assert.equal(ref.family, "typeorm");
  assert.equal(ref.operation, "read");
  assert.equal(ref.methodShape, "findOne");
  assert.equal(ref.details.resourceName, "User");
});

test("16. Sequelize read: detects User.findAll(...)", () => {
  const code = `
import { Model } from "sequelize";
class User extends Model {}
const users = await User.findAll();
`;
  const input: RepositoryDatabaseDetectionInput = {
    files: new Map([["src/seq-read.ts", code]]),
  };
  const result = detectRepositoryDatabaseReferences(input);

  assert.equal(result.references.length, 1);
  const ref = result.references[0];
  assert.ok(ref);
  assert.equal(ref.family, "sequelize");
  assert.equal(ref.operation, "read");
  assert.equal(ref.methodShape, "findAll");
  assert.equal(ref.details.resourceName, "User");
});

test("17. Sequelize create: detects User.create(...)", () => {
  const code = `
import { Model } from "sequelize";
class User extends Model {}
await User.create({ name: "Alice" });
`;
  const input: RepositoryDatabaseDetectionInput = {
    files: new Map([["src/seq-create.ts", code]]),
  };
  const result = detectRepositoryDatabaseReferences(input);

  assert.equal(result.references.length, 1);
  const ref = result.references[0];
  assert.ok(ref);
  assert.equal(ref.family, "sequelize");
  assert.equal(ref.operation, "insert");
  assert.equal(ref.methodShape, "create");
  assert.equal(ref.details.resourceName, "User");
});

test("18. Sequelize update/delete: detects User.update(...) and User.destroy(...)", () => {
  const code = `
import { Model } from "sequelize";
class User extends Model {}
await User.update({ active: true }, { where: { id: 1 } });
await User.destroy({ where: { id: 2 } });
`;
  const input: RepositoryDatabaseDetectionInput = {
    files: new Map([["src/seq-mutations.ts", code]]),
  };
  const result = detectRepositoryDatabaseReferences(input);

  assert.equal(result.references.length, 2);
  const ref1 = result.references[0];
  const ref2 = result.references[1];
  assert.ok(ref1);
  assert.ok(ref2);

  assert.equal(ref1.family, "sequelize");
  assert.equal(ref1.operation, "update");
  assert.equal(ref1.methodShape, "update");
  assert.equal(ref1.details.resourceName, "User");

  assert.equal(ref2.family, "sequelize");
  assert.equal(ref2.operation, "delete");
  assert.equal(ref2.methodShape, "destroy");
  assert.equal(ref2.details.resourceName, "User");
});

test("19. Sequelize upsert: detects User.upsert(...)", () => {
  const code = `
import { Model } from "sequelize";
class User extends Model {}
await User.upsert({ id: 1, name: "Alice" });
`;
  const input: RepositoryDatabaseDetectionInput = {
    files: new Map([["src/seq-upsert.ts", code]]),
  };
  const result = detectRepositoryDatabaseReferences(input);

  assert.equal(result.references.length, 1);
  const ref = result.references[0];
  assert.ok(ref);
  assert.equal(ref.family, "sequelize");
  assert.equal(ref.operation, "upsert");
  assert.equal(ref.methodShape, "upsert");
  assert.equal(ref.details.resourceName, "User");
});

test("20. static resource/model/table extraction", () => {
  const code = `
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
await prisma.product.findMany();
`;
  const input: RepositoryDatabaseDetectionInput = {
    files: new Map([["src/product.ts", code]]),
  };
  const result = detectRepositoryDatabaseReferences(input);

  assert.equal(result.references.length, 1);
  assert.equal(result.references[0]?.details.resourceName, "product");
  assert.equal(result.references[0]?.details.status, "resolved");
});

test("21. unresolved dynamic resource: flags dynamic ORM calls", () => {
  const code = `
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
const modelName = getModel();
await prisma[modelName].findMany();
`;
  const input: RepositoryDatabaseDetectionInput = {
    files: new Map([["src/dynamic-model.ts", code]]),
  };
  const result = detectRepositoryDatabaseReferences(input);

  assert.equal(result.references.length, 1);
  const ref = result.references[0];
  assert.ok(ref);
  assert.equal(ref.details.resourceName, null);
  assert.equal(ref.details.status, "unresolved");
});

test("22. unrelated .findMany() false-positive rejection", () => {
  const code = `
// Arbitrary object without ORM provenance
const foo = {
  findMany: () => [1, 2, 3]
};
foo.findMany();
`;
  const input: RepositoryDatabaseDetectionInput = {
    files: new Map([["src/fake-find.ts", code]]),
  };
  const result = detectRepositoryDatabaseReferences(input);

  assert.equal(result.references.length, 0);
});

test("23. unrelated .save() false-positive rejection", () => {
  const code = `
// File saver or arbitrary repository object without ORM provenance
const file = { save: () => {} };
file.save();

const repository = { save: () => {} };
repository.save();
`;
  const input: RepositoryDatabaseDetectionInput = {
    files: new Map([["src/fake-save.ts", code]]),
  };
  const result = detectRepositoryDatabaseReferences(input);

  assert.equal(result.references.length, 0);
});

test("24. unrelated .create() false-positive rejection", () => {
  const code = `
// DOM element or custom builder without ORM model evidence
const element = document.createElement("div");
const model = { create: () => {} };
model.create();
`;
  const input: RepositoryDatabaseDetectionInput = {
    files: new Map([["src/fake-create.ts", code]]),
  };
  const result = detectRepositoryDatabaseReferences(input);

  assert.equal(result.references.length, 0);
});

test("25. deterministic ordering and deterministic IDs", () => {
  const file1 = `
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
await prisma.user.findMany();
await prisma.post.create({ data: {} });
`;
  const file2 = `
import { Model } from "sequelize";
class User extends Model {}
await User.findAll();
`;
  const input: RepositoryDatabaseDetectionInput = {
    files: new Map([
      ["src/z_file.ts", file1],
      ["src/a_file.ts", file2],
    ]),
  };

  const res1 = detectRepositoryDatabaseReferences(input);
  const res2 = detectRepositoryDatabaseReferences(input);

  assert.deepEqual(res1, res2);

  // Sorting: src/a_file.ts before src/z_file.ts
  assert.equal(res1.references.length, 3);
  assert.equal(res1.references[0]?.filePath, "src/a_file.ts");
  assert.equal(res1.references[1]?.filePath, "src/z_file.ts");
  assert.equal(res1.references[2]?.filePath, "src/z_file.ts");

  // ID format
  assert.ok(res1.references[0]?.id.startsWith("src/a_file.ts#db:sequelize:read:"));
});

test("26. ignored directories are skipped", () => {
  const code = `
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
await prisma.user.findMany();
`;
  const input: RepositoryDatabaseDetectionInput = {
    files: new Map([
      ["node_modules/pkg/index.ts", code],
      [".next/server/pages/api.ts", code],
    ]),
  };
  const result = detectRepositoryDatabaseReferences(input);

  assert.equal(result.references.length, 0);
});

test("27. malformed source handled safely", () => {
  const code = `
import { PrismaClient } from "@prisma/client"
const prisma = new PrismaClient(
`;
  const input: RepositoryDatabaseDetectionInput = {
    files: new Map([["src/malformed.ts", code]]),
  };
  const result = detectRepositoryDatabaseReferences(input);
  assert.ok(result);
});

test("28. synthetic multi-file repository fixture covering all supported families", () => {
  const files = new Map<string, string>([
    [
      "src/db/prisma.ts",
      `import { PrismaClient } from "@prisma/client";
export const prisma = new PrismaClient();
await prisma.user.findUnique({ where: { id: "1" } });
await prisma.user.create({ data: { name: "Alice" } });
await prisma.user.update({ where: { id: "1" }, data: {} });
await prisma.user.delete({ where: { id: "1" } });
await prisma.user.upsert({ where: { id: "1" }, create: {}, update: {} });
await prisma.$queryRaw\`SELECT 1\`;
`,
    ],
    [
      "src/db/drizzle.ts",
      `import { select, insert, update, delete as del } from "drizzle-orm";
import { users } from "./schema";
await select().from(users);
await insert(users).values({ name: "Bob" });
await update(users).set({ name: "Bob Jr" });
await del(users);
`,
    ],
    [
      "src/db/typeorm.ts",
      `import { getRepository, EntityManager } from "typeorm";
import { User } from "./User";
const userRepo = getRepository(User);
await userRepo.find();
await userRepo.save(new User());
async function run(manager: EntityManager) {
  await manager.find(User);
}
`,
    ],
    [
      "src/db/sequelize.ts",
      `import { Model } from "sequelize";
class Order extends Model {}
await Order.findAll();
await Order.create({ total: 100 });
await Order.update({ status: "paid" }, { where: { id: 1 } });
await Order.destroy({ where: { id: 1 } });
await Order.upsert({ id: 1, total: 150 });
`,
    ],
  ]);

  const result = detectRepositoryDatabaseReferences({ files });

  assert.equal(result.counts.totalReferences, 18);
  assert.equal(result.counts.byFamily.prisma, 6);
  assert.equal(result.counts.byFamily.drizzle, 4);
  assert.equal(result.counts.byFamily.typeorm, 3);
  assert.equal(result.counts.byFamily.sequelize, 5);
  assert.equal(result.diagnostics.length, 0);
});

test("29. Golden fixture scan safely runs and confirms zero false positives on Next.js taxonomy codebase", () => {
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

  const result = detectRepositoryDatabaseReferences({ files });

  // Verify scan completes safely with zero diagnostics and representative expected detections if present or zero false positives
  assert.ok(result);
  assert.equal(result.diagnostics.length, 0);
  assert.equal(result.references.length, 0);
});

