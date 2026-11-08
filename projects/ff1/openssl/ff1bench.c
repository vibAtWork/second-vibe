/* Cross-language FF1 benchmark protocol (see ../bench/PROTOCOL.md).
 * ff1bench <radix> <n> <keybits> <tweaklen> */
#include "ff1.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

static double now(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec + ts.tv_nsec * 1e-9;
}
static double envf(const char *n, double d)
{
    const char *s = getenv(n);
    return s ? atof(s) : d;
}
static int cmpd(const void *a, const void *b)
{
    double x = *(const double *)a, y = *(const double *)b;
    return (x > y) - (x < y);
}

static ff1_ctx C;
static uint8_t tweak[256];
static size_t tlen, n;
static uint16_t *buf;

static double measure(int enc)
{
    double warm = envf("FF1_WARMUP", 1.0), sample = envf("FF1_SAMPLE", 0.25);
    int ns = (int)envf("FF1_SAMPLES", 7);
    double res[64], t0 = now();
    long count = 0;
    while (now() - t0 < warm) {
        enc ? ff1_encrypt(&C, tweak, tlen, buf, buf, n) : ff1_decrypt(&C, tweak, tlen, buf, buf, n);
        count++;
    }
    long per = (long)(count * sample / warm);
    if (per < 1) per = 1;
    for (int s = 0; s < ns; s++) {
        double a = now();
        for (long i = 0; i < per; i++)
            enc ? ff1_encrypt(&C, tweak, tlen, buf, buf, n) : ff1_decrypt(&C, tweak, tlen, buf, buf, n);
        res[s] = (now() - a) * 1e9 / per;
    }
    qsort(res, ns, sizeof(double), cmpd);
    return res[ns / 2];
}

int main(int argc, char **argv)
{
    static const char *ALPHA = "0123456789abcdefghijklmnopqrstuvwxyz";
    if (argc != 5) { fprintf(stderr, "usage: ff1bench radix n keybits tweaklen\n"); return 2; }
    unsigned radix = atoi(argv[1]);
    n = atoi(argv[2]);
    int keybits = atoi(argv[3]);
    tlen = atoi(argv[4]);
    uint8_t key[32];
    for (int i = 0; i < keybits / 8; i++) key[i] = (uint8_t)i;
    for (size_t i = 0; i < tlen; i++) tweak[i] = (uint8_t)i;
    uint16_t *pt = malloc(n * 2), *ct = malloc(n * 2), *back = malloc(n * 2);
    buf = malloc(n * 2);
    for (size_t i = 0; i < n; i++) pt[i] = (uint16_t)((i * 7 + 3) % radix);
    if (ff1_init(&C, key, keybits / 8, radix) || ff1_encrypt(&C, tweak, tlen, pt, ct, n) ||
        ff1_decrypt(&C, tweak, tlen, ct, back, n) || memcmp(pt, back, n * 2)) {
        fprintf(stderr, "round trip failed\n");
        return 1;
    }
    char *s = malloc(n + 1);
    for (size_t i = 0; i < n; i++) s[i] = ALPHA[ct[i]];
    s[n] = 0;
    memcpy(buf, pt, n * 2);
    double e = measure(1);
    memcpy(buf, ct, n * 2);
    double d = measure(0);
    printf("c-openssl,%u,%zu,%d,%zu,encrypt,%.1f,%s\n", radix, n, keybits, tlen, e, s);
    printf("c-openssl,%u,%zu,%d,%zu,decrypt,%.1f,%s\n", radix, n, keybits, tlen, d, s);
    ff1_free(&C);
    return 0;
}
