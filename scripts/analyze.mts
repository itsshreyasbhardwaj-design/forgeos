/**
 * Analyse any local repository from the terminal, without starting the app.
 *
 *   pnpm analyze ../some-project
 *   pnpm analyze ../some-project --json > report.json
 *
 * Useful for sanity-checking the engines against real codebases and for
 * wiring ForgeOS analysis into CI without a network round-trip.
 */
import { scanDirectory } from '../packages/core/src/fs/node.js';
import { analyseRepository, summariseAnalysis } from '../packages/core/src/analysis/repository.js';
import { formatBytes } from '../packages/core/src/kernel/text.js';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const target = args.find((arg) => !arg.startsWith('--')) ?? '.';

const startedAt = Date.now();
const snapshot = await scanDirectory(target);
const analysis = analyseRepository(snapshot);

if (asJson) {
  process.stdout.write(JSON.stringify(analysis, null, 2));
} else {
  const summary = summariseAnalysis(analysis);
  const line = (label: string, value: string): void =>
    console.log(`  ${label.padEnd(22)} ${value}`);

  console.log(`\n${summary.name} — ${summary.description || 'no description'}\n`);
  line('Stack', summary.stackSummary);
  line('Files', `${summary.files.toLocaleString()} (${formatBytes(analysis.overview.bytes)})`);
  line('Lines of code', summary.code.toLocaleString());
  line('Comment ratio', `${(analysis.overview.commentRatio * 100).toFixed(1)}%`);
  line('Health', `${summary.healthScore}/100 (grade ${summary.grade})`);
  line('Estimated debt', `${analysis.debt.estimatedDays} days`);
  line('Module graph', `${analysis.graph.nodes.length} nodes, ${analysis.graph.edges.length} edges`);
  line('Circular deps', String(analysis.cycles.length));
  line('HTTP routes', `${summary.routes} (${analysis.api.frameworks.join(', ') || 'none'})`);
  line('DB entities', `${summary.entities} (${analysis.schema.dialect})`);

  console.log('\n  Languages');
  for (const language of analysis.languages.slice(0, 6)) {
    console.log(
      `    ${language.name.padEnd(20)} ${String(language.percentage).padStart(5)}%  ${language.code.toLocaleString()} LOC`
    );
  }

  console.log('\n  Highest-risk modules');
  for (const hotspot of analysis.hotspots.slice(0, 6)) {
    console.log(`    ${String(hotspot.risk).padStart(5)}  ${hotspot.path}  (${hotspot.reason})`);
  }

  console.log('\n  Top findings');
  for (const finding of analysis.debt.findings.slice(0, 8)) {
    const where = finding.line ? `${finding.file}:${finding.line}` : finding.file;
    console.log(`    [${finding.severity.padEnd(8)}] ${finding.title} — ${where}`);
  }

  console.log(
    `\n  Analysed in ${analysis.durationMs}ms (${Date.now() - startedAt}ms including scan)\n`
  );
}
