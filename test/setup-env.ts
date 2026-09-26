// Tests make their own git repos and authors. Run from inside a seat's desk, the seat's
// GIT_AUTHOR_* / GIT_COMMITTER_* would win over the tests' -c user.name, so clear them.
for (const k of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) {
  delete process.env[k];
}
