#include <stdio.h>
#include <stdlib.h>

int main(int argc, char **argv) {
  unsigned char buffer[4096];
  FILE *output;
  if (argc != 2 || argv[1] == NULL) return 2;
  output = fopen(argv[1], "wb");
  if (output == NULL) return 3;
  for (;;) {
    const size_t count = fread(buffer, 1U, sizeof(buffer), stdin);
    if (count > 0U && fwrite(buffer, 1U, count, output) != count) {
      (void)fclose(output);
      return 4;
    }
    if (count < sizeof(buffer)) {
      if (ferror(stdin) != 0) {
        (void)fclose(output);
        return 5;
      }
      break;
    }
  }
  if (fclose(output) != 0) return 6;
  abort();
}
