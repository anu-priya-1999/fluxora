# 20. Senior/Staff Interview Questions This Architecture Should Prepare You For

Grouped by theme. Answering these well means understanding the *reasoning*, not memorizing this document.

## AI system design & reliability

1. Where exactly is the line between "deterministic" and "AI-generated" in this system, and why did you draw it there?
2. How do you know your AI layer isn't hallucinating? Walk me through the actual mechanism, not just "we validate the output."
3. What happens, step by step, when the LLM API is down? What does the user actually see?
4. How would you detect a silent regression in AI output quality after a prompt change ships?
5. Why not just give the LLM full repository access and let it reason freely — what specifically breaks if you do that?
6. How do you defend against prompt injection from content inside the repository itself?
7. Explain your context-assembly strategy. Why is "less context, more scoped" better than "more context, let the model figure it out" here?
8. How would you A/B test a new prompt version safely in production?
9. What's your strategy for controlling LLM cost as usage scales 100x?
10. How do you decide which tasks get your most capable model vs. a cheaper one?

## Data modeling & storage

11. Why Postgres instead of a graph database for the core dependency graph? What would change your mind?
12. Walk me through your schema for representing a heterogeneous graph (nodes of many types) in a relational database. What are the trade-offs of the approach you chose?
13. How do you model "confidence" and "provenance" in your schema, and why does that matter for this product?
14. What does your evidence model actually look like at the row level, and how do you guarantee every claim traces back to it?
15. How would you shard this database at 10,000 tenants, and why did you choose that sharding key?
16. Why is your graph versioned per `AnalysisRun` instead of mutated in place? What problem does that solve?

## Distributed systems & reliability

17. Walk me through what happens if a worker crashes halfway through writing a large analysis run. How do you guarantee you don't end up with a corrupted or duplicated graph?
18. How do you guarantee idempotency across your job queue, end to end?
19. Why a transactional outbox pattern for events instead of just publishing directly from application code?
20. What ordering guarantees does your event system provide, and what happens if you need stronger guarantees later?
21. How would you handle a "poison pill" job that always fails and keeps getting retried?
22. Design the dead-letter and replay strategy for a failed analysis job.

## Static analysis / code intelligence

23. What are the fundamental limits of static analysis for a dynamic language like JavaScript, and how does your product surface those limits honestly to the user instead of hiding them?
24. How do you handle path aliases, barrel files, and monorepo workspace references correctly?
25. Compare the TypeScript Compiler API / ts-morph approach vs. tree-sitter. When would you use each?
26. How would you extend this system to support a new language like Python or Go? What in your architecture makes that easy or hard?

## Product & scope judgment

27. Why did you cut runtime telemetry and multi-language support from the MVP? How did you decide what NOT to build first?
28. If a user says "Fluxora said X was safe to change and it broke production," what's your incident response, and what does that reveal about a gap in your confidence model?
29. How do you validate that your blast-radius output is actually correct, not just "looks plausible"? What's your ground truth?
30. What's the single most likely way this product silently loses user trust, and what did you build specifically to prevent it?

## Scaling & cost

31. Walk me through what changes in this architecture going from 1 repository to 10,000 repositories. What stays the same?
32. What's your single biggest cost driver, and what are three concrete ways you'd reduce it without hurting quality?
33. At what point would you introduce Kafka, and why not from day one?

## Security

34. What's your threat model for a customer's private source code, and how does the architecture address each part of it?
35. Why does your analysis pipeline never execute customer code, and what would you lose/gain if it did?
36. How do you enforce tenant isolation at more than one layer, and why is one layer not enough?

## Systems thinking / trade-offs (meta-questions)

37. What's the single architectural decision here you're least confident about, and what would make you revisit it?
38. If you had to cut this project's scope in half for a 4-week deadline, what would you cut, and why would that specific cut preserve the most value?
39. What's a decision in this architecture that looks over-engineered for a portfolio project but is actually load-bearing for the story you're telling — and one that's genuinely over-engineered and you'd simplify?
