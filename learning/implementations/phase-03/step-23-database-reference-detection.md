# Step 23 — Database Reference Detection

## Overview

Step 23 adds deterministic, AST-based static database reference detection for Fluxora's code intelligence pipeline.

It detects database interaction points across four primary ORM ecosystems:
1. **Prisma** (`prisma.user.findMany`, `prisma.user.create`, `prisma.user.update`, `prisma.user.delete`, `prisma.user.upsert`, `$queryRaw`, `$executeRaw`, `$transaction`)
2. **Drizzle ORM** (`select().from(users)`, `insert(users)`, `update(users)`, `delete(users)`, `db.query.users.findMany`)
3. **TypeORM** (`getRepository(User).find`, `userRepo.save`, `manager.find(User)`, `manager.save(User)`)
4. **Sequelize** (`User.findAll`, `User.create`, `User.update`, `User.destroy`, `User.upsert`)

## Standard Operation Taxonomy

All detected database references are mapped into a standardized operation taxonomy:
- `read` (findMany, findUnique, select, findAll, findOne, findByPk, etc.)
- `insert` (create, createMany, insert, save, bulkCreate)
- `update` (update, updateMany)
- `delete` (delete, deleteMany, remove, destroy)
- `upsert` (upsert)
- `query` ($queryRaw, $queryRawUnsafe)
- `execute` ($executeRaw, $executeRawUnsafe)
- `transaction` ($transaction)

## Provenance Rules & False-Positive Prevention

To ensure high precision and eliminate false positives:
- Call sites are evaluated against in-file ORM provenance scopes established from top-level module imports (`@prisma/client`, `drizzle-orm`, `typeorm`, `sequelize`), CommonJS requires, class declarations (`extends Model`, `extends BaseEntity`, `@Entity()`), and variable instantiations (`new PrismaClient()`, `drizzle()`, `getRepository(User)`).
- Arbitrary object methods (e.g. `foo.findMany()`, `file.save()`, `element.create()`, `user.update()`) without proven ORM provenance are strictly excluded.
- Lowercase variable calls without ORM static binding are rejected.

## Static Resource Name Resolution

- Resource (model, table, entity) names are extracted when statically knowable (string literals, identifier names, or no-substitution template literals).
- Dynamic or computed resource expressions (e.g. `prisma[dynamicModel].findMany()`) fall back safely to `resourceName: null` with `status: "unresolved"`.
- Raw database queries (`$queryRaw`, `$executeRaw`) carry `resourceName: null` with `status: "resolved"`.

## Invariants

- **Static & Deterministic**: AST parsing via TypeScript Compiler API; 100% reproducible ordering and deterministic IDs.
- **Side-Effect Free**: Never executes repository code, connects to live databases, or imports customer modules.
- **Fault-Tolerant**: Malformed files emit diagnostics without failing execution.

## Verification

Validated with 29 focused tests including synthetic multi-file repository fixtures and offline golden fixture repository scan.

