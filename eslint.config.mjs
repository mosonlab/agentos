// The type-aware half of the minimum lint gate (#143). It enforces one thing —
// that a promise is never dropped — through two rules that are one rule between
// them: @typescript-eslint/no-floating-promises for the general case, and a
// no-restricted-syntax selector covering the single blind spot the first one's
// node:test exemption cannot avoid. Both are explained at their definitions
// below.
//
// Why not Biome, which has a rule of the same name:
//
//   Biome 2.5 infers types itself rather than asking tsc, and that inference
//   stops at the package boundary. Measured on this repository at the time of
//   writing: Biome flags a floating promise from a function declared in the
//   same package, and reports nothing at all for `prisma.$disconnect()` or any
//   other call whose type comes through node_modules — which is nearly every
//   promise that matters here, since the Prisma client is the main source of
//   them. A rule that is silent on the most common shape is not a gate.
//
//   typescript-eslint asks the TypeScript program, so it sees those. The cost
//   is a second lint tool and roughly nine seconds a run; the benefit is that
//   the rule actually holds. Biome keeps its own version of the rule on as a
//   cheaper second net that also reaches the .mjs scripts no tsconfig covers.
//
// Nothing else is enabled here. Style, imports and formatting are Biome's or
// nobody's; this file exists for the one thing Biome cannot do.

import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'packages/db/generated/**',
      // The one tracked TypeScript file this pass deliberately does not cover
      // lives under docs/ and is input to a shell script's `--self-test`, not
      // code that runs, and it is outside every tsconfig by design. Everything
      // else tracked and TypeScript-suffixed is linted —
      // where no tsconfig reaches it, via allowDefaultProject below rather than
      // by being added here.
      'docs/**',
    ],
  },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: {
          // Real code that no tsconfig `include` reaches: the db maintenance
          // scripts run through tsx, and the pi extension is compiled by pi
          // rather than by the runner. They are exactly where an unhandled
          // rejection is least likely to be noticed, so they are linted from an
          // inferred project rather than skipped.
          //
          // @agentos/build-info is on the list for a different reason. It is a
          // plain-JS workspace whose public type surface is a hand-written
          // index.d.ts, so it has no tsconfig for the project service to place
          // the file in, and an unplaceable file is a parse error rather than a
          // skip — correct, fail-closed, and on 2026-08-18 it turned `npm run
          // lint` red on master itself for every branch in flight.
          //
          // Listed rather than ignored, even though a declaration file cannot
          // trip either rule in this config: both key on expression statements,
          // and a .d.ts holds only ambient declarations. Adding `!**/*.d.ts`
          // would be just as green today, and would quietly stop being so the
          // moment a rule that does apply to declarations is enabled.
          //
          // Named exactly, not globbed, for the same reason. A
          // `packages/build-info/*.d.ts` would silently absorb the next
          // declaration file added to that directory, which is precisely the
          // event that should make someone look at this list and decide whether
          // the package has outgrown having no tsconfig. The two globs above
          // are globs because they cover directories of interchangeable
          // scripts; this is one hand-written file, so it is one entry.
          allowDefaultProject: [
            'packages/db/prisma/*.ts',
            'packages/runner/assets/*.ts',
            'packages/build-info/index.d.ts',
          ],
          // 13 files match the globs above; the default ceiling is 8.
          maximumDefaultProjectFileMatchCount_THIS_WILL_SLOW_DOWN_LINTING: 20,
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      '@typescript-eslint/no-floating-promises': [
        'error',
        {
          // `node:test`'s test/hook functions return a promise that the runner
          // itself awaits; a bare `test("...", fn)` at the top of a file is the
          // documented way to use them, not a leak. Without this the rule
          // reports 1044 call sites in this repository, every one of them a
          // false positive, which is how a gate gets turned off.
          //
          // This exemption cannot be narrowed to top-level calls, and the
          // no-restricted-syntax rule below exists to make up the difference.
          // @types/node declares `TestContext.test: typeof test` — the subtest
          // method and the imported function are literally the same type — and
          // typescript-eslint's matcher only derives a name from an Identifier
          // callee, so `t.test(...)` misses the value check and is caught by the
          // type check against that shared symbol. Every specifier form (file,
          // lib, package; string or array name) resolves through that same
          // symbol, so no configuration of this option can separate them.
          allowForKnownSafeCalls: [
            {
              from: 'package',
              package: 'node:test',
              name: ['after', 'afterEach', 'before', 'beforeEach', 'describe', 'it', 'test'],
            },
          ],
        },
      ],

      // The other half of the subtest rule: what no-floating-promises is forced
      // to wave through above, this catches syntactically.
      //
      // `t.test(...)` / `suite.test(...)` on a TestContext really does have to
      // be awaited — the parent test finishes without it and the subtest's
      // failures land on nobody. There are 23 such calls on this branch, all
      // correctly awaited today: 10 in packages/api/src/files/session-routes.test.ts,
      // 8 in packages/api/src/files/routes.test.ts, 3 in
      // packages/api/src/files/grant-alias.test.ts, and 2 in
      // packages/api/src/control-plane-ownership.test.ts. Without this rule any
      // future one of them could lose its `await` and still gate green, which
      // is exactly the zero-tolerance-on-new-code promise #143 is making.
      //
      // The selector is "a `.test(...)` call whose result is discarded": it
      // fires only when the call is the whole of an expression statement, so
      // `await`, `return`, `void`, `.catch(...)` and being passed as an
      // argument all still pass — the same escapes no-floating-promises itself
      // accepts. It is syntactic rather than type-aware, which makes it
      // over-broad by exactly one shape: a bare `pattern.test(str);` statement
      // on a RegExp. That is a discarded boolean and a bug under either
      // reading, and there are none in the tree.
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'ExpressionStatement > CallExpression[callee.type="MemberExpression"][callee.computed=false][callee.property.name="test"]',
          message:
            'A `.test(...)` call whose result is discarded: a node:test subtest must be awaited (`await t.test(...)`), or the parent test finishes without it.',
        },
        {
          // Same shape written as `t["test"](...)`, so the rule cannot be
          // stepped around by quoting the property.
          selector:
            'ExpressionStatement > CallExpression[callee.type="MemberExpression"][callee.computed=true][callee.property.value="test"]',
          message:
            'A `.test(...)` call whose result is discarded: a node:test subtest must be awaited (`await t.test(...)`), or the parent test finishes without it.',
        },
      ],
    },
  },
);
