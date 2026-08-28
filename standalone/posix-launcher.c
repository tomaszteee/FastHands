#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#ifdef __APPLE__
#include <mach-o/dyld.h>
#endif

static int executable_dir(char *out, size_t size) {
#ifdef __APPLE__
  uint32_t n = (uint32_t)size;
  if (_NSGetExecutablePath(out, &n) != 0) return -1;
  char resolved[PATH_MAX];
  if (!realpath(out, resolved)) return -1;
  strncpy(out, resolved, size - 1); out[size - 1] = 0;
#else
  ssize_t n = readlink("/proc/self/exe", out, size - 1);
  if (n < 0) return -1; out[n] = 0;
#endif
  char *slash = strrchr(out, '/');
  if (!slash) return -1; *slash = 0; return 0;
}

int main(int argc, char **argv) {
  char dir[PATH_MAX];
  if (executable_dir(dir, sizeof(dir)) != 0) { fprintf(stderr, "Fast Hands: cannot locate executable directory\n"); return 1; }
  char node[PATH_MAX], script[PATH_MAX];
  snprintf(node, sizeof(node), "%s/runtime/node", dir);
  snprintf(script, sizeof(script), "%s/app/node_modules/fast-hands-mcp/bin/fast-hands.mjs", dir);
  char **args = calloc((size_t)argc + 2, sizeof(char*));
  if (!args) return 1;
  args[0] = node; args[1] = script;
  for (int i = 1; i < argc; i++) args[i + 1] = argv[i];
  execv(node, args);
  fprintf(stderr, "Fast Hands: failed to start bundled Node runtime: %s\n", strerror(errno));
  return 1;
}
