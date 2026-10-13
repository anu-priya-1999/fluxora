export default function ExplorerLoading() {
  return (
    <div data-testid="explorer-page-loading" className="p-8 text-center text-slate-600">
      <h2 className="text-xl font-semibold mb-2">Loading Repository Context</h2>
      <p>Resolving analysis run and repository state...</p>
    </div>
  );
}
