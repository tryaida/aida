// Test fixture for the frame-diff worker-pool exit-handling regression test: a worker that starts
// successfully (so it never fires Worker's "error" event) but exits immediately on its own,
// without responding to any task. Before the fix, nothing in `diffWithWorkerPool` resolved the
// pool's promise for a worker that goes away this way, so the whole capture run would hang
// forever instead of falling back to the synchronous diff path.
process.exit(1);
