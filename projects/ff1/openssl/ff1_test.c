#include "ff1.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static const char *ALPHA = "0123456789abcdefghijklmnopqrstuvwxyz";
static int failures = 0;

static size_t hex(const char *s, uint8_t *out)
{
    size_t n = strlen(s) / 2;
    for (size_t i = 0; i < n; i++)
        sscanf(s + 2 * i, "%2hhx", &out[i]);
    return n;
}
static void parse(const char *s, uint16_t *out)
{
    for (size_t i = 0; s[i]; i++)
        out[i] = (uint16_t)(strchr(ALPHA, s[i]) - ALPHA);
}
static void fmt(const uint16_t *x, size_t n, char *out)
{
    for (size_t i = 0; i < n; i++)
        out[i] = ALPHA[x[i]];
    out[n] = 0;
}

#define K128 "2B7E151628AED2A6ABF7158809CF4F3C"
#define K192 K128 "EF4359D8D580AA4F"
#define K256 K192 "7F036D6F04FC6A94"
#define T1 "39383736353433323130"
#define T2 "3737373770717273373737"

static const struct { const char *key, *tweak; unsigned radix; const char *pt, *ct; } V[] = {
    {K128, "", 10, "0123456789", "2433477484"},
    {K128, T1, 10, "0123456789", "6124200773"},
    {K128, T2, 36, "0123456789abcdefghi", "a9tv40mll9kdu509eum"},
    {K192, "", 10, "0123456789", "2830668132"},
    {K192, T1, 10, "0123456789", "2496655549"},
    {K192, T2, 36, "0123456789abcdefghi", "xbj3kv35jrawxv32ysr"},
    {K256, "", 10, "0123456789", "6657667009"},
    {K256, T1, 10, "0123456789", "1001623463"},
    {K256, T2, 36, "0123456789abcdefghi", "xs8a0azh2avyalyzuwd"},
};

static uint64_t rng = 0x123456789abcdef0ULL;
static uint64_t rnd(void) { rng ^= rng << 13; rng ^= rng >> 7; rng ^= rng << 17; return rng; }

int main(void)
{
    for (size_t i = 0; i < sizeof V / sizeof V[0]; i++) {
        uint8_t key[32], tw[64];
        uint16_t x[64], y[64];
        char s[64];
        size_t kl = hex(V[i].key, key), tl = hex(V[i].tweak, tw), n = strlen(V[i].pt);
        ff1_ctx c;
        if (ff1_init(&c, key, kl, V[i].radix)) { puts("init failed"); return 1; }
        parse(V[i].pt, x);
        if (ff1_encrypt(&c, tw, tl, x, y, n)) { puts("encrypt error"); failures++; }
        fmt(y, n, s);
        if (strcmp(s, V[i].ct)) { printf("sample %zu encrypt: got %s want %s\n", i + 1, s, V[i].ct); failures++; }
        ff1_decrypt(&c, tw, tl, y, y, n); /* in-place */
        fmt(y, n, s);
        if (strcmp(s, V[i].pt)) { printf("sample %zu decrypt: got %s want %s\n", i + 1, s, V[i].pt); failures++; }
        ff1_free(&c);
    }
    static const unsigned radices[] = {2, 3, 10, 16, 26, 36, 62, 255, 256, 1000, 65535, 65536};
    int trips = 0;
    for (int it = 0; it < 2000; it++) {
        unsigned radix = radices[it % 12];
        size_t kl = (size_t[]){16, 24, 32}[it % 3], tl = rnd() % 40, n = 2 + (it % 7 == 0 ? rnd() % 600 : it % 2 ? rnd() % 40 : rnd() % 150);
        uint8_t key[32], tw[40];
        uint16_t x[640], y[640], z[640];
        for (size_t i = 0; i < kl; i++) key[i] = (uint8_t)rnd();
        for (size_t i = 0; i < tl; i++) tw[i] = (uint8_t)rnd();
        for (size_t i = 0; i < n; i++) x[i] = (uint16_t)(rnd() % radix);
        ff1_ctx c;
        ff1_init(&c, key, kl, radix);
        int r = ff1_encrypt(&c, tw, tl, x, y, n);
        if (r == FF1_ERR_LENGTH) { ff1_free(&c); continue; }
        if (r || ff1_decrypt(&c, tw, tl, y, z, n) || memcmp(x, z, n * 2)) {
            printf("round trip failed radix=%u n=%zu\n", radix, n);
            failures++;
        }
        /* The 128-bit fast path, the limb path and the BIGNUM path must agree. */
        for (int fp = 1; fp <= 2; fp++) {
            ff1_ctx s;
            uint16_t w[640], z2[640];
            ff1_init(&s, key, kl, radix);
            s.force_path = fp;
            if (ff1_encrypt(&s, tw, tl, x, w, n) || memcmp(w, y, n * 2) ||
                ff1_decrypt(&s, tw, tl, w, z2, n) || memcmp(z2, x, n * 2)) {
                printf("path %d mismatch radix=%u n=%zu\n", fp, radix, n);
                failures++;
            }
            ff1_free(&s);
        }
        trips++;
        ff1_free(&c);
    }
    /* validation */
    ff1_ctx c;
    uint8_t zk[16] = {0};
    uint16_t buf[8] = {1, 2, 3, 4, 5, 6, 10};
    if (ff1_init(&c, zk, 16, 1) != FF1_ERR_RADIX) failures++;
    if (ff1_init(&c, zk, 15, 10) != FF1_ERR_KEY) failures++;
    ff1_init(&c, zk, 16, 10);
    if (ff1_encrypt(&c, NULL, 0, buf, buf, 5) != FF1_ERR_LENGTH) failures++;
    if (ff1_encrypt(&c, NULL, 0, buf, buf, 7) != FF1_ERR_DIGIT) failures++;
    ff1_free(&c);

    printf("%s: 9 NIST vectors, %d random round trips (each checked across fast, limb and BIGNUM paths), validation checks; %d failures\n",
           failures ? "FAIL" : "PASS", trips, failures);
    return failures != 0;
}
