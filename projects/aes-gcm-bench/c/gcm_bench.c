/*
 * AES-GCM throughput benchmark for OpenSSL libcrypto (EVP API).
 *
 * Methodology mirrors java/GcmBench.java so the numbers are comparable:
 *   encrypt: per message -> EncryptInit(key, fresh 12-byte IV) + Update + Final + GET_TAG
 *   decrypt: per message -> DecryptInit(key, fixed IV) + Update + SET_TAG + Final (tag verify)
 * The key is passed on every init (like Cipher.init in Java), so the key
 * schedule cost is included. Use --no-rekey to set the key only once.
 *
 * Output: CSV lines  impl,op,keybits,size,ops,seconds,MBps
 *
 * Build: cc -O2 -o gcm_bench gcm_bench.c -lcrypto
 */
#include <openssl/evp.h>
#include <openssl/crypto.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

static double seconds = 1.0, warmup = 1.0;
static int sizes[64] = {16, 64, 256, 1024, 8192, 16384, 1 << 20}, nsizes = 7;
static int keybits[8] = {128, 256}, nkeys = 2;
static int rekey = 1;
static volatile unsigned long sink;

static double now(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec + ts.tv_nsec / 1e9;
}

static void die(const char *m) { fprintf(stderr, "error: %s\n", m); exit(1); }

static int parse_list(const char *s, int *out, int max) {
    int n = 0;
    char *dup = strdup(s), *save = NULL;
    for (char *t = strtok_r(dup, ",", &save); t && n < max; t = strtok_r(NULL, ",", &save))
        out[n++] = atoi(t);
    free(dup);
    return n;
}

static const EVP_CIPHER *cipher_for(int bits) {
    return bits == 128 ? EVP_aes_128_gcm() : bits == 192 ? EVP_aes_192_gcm() : EVP_aes_256_gcm();
}

static int encrypt1(EVP_CIPHER_CTX *ctx, const EVP_CIPHER *c, const unsigned char *key, const unsigned char *iv,
                    const unsigned char *aad, int aadlen, const unsigned char *in, int len,
                    unsigned char *out, unsigned char *tag) {
    int l1 = 0, l2 = 0;
    if (!EVP_EncryptInit_ex(ctx, c, NULL, key, iv)) die("EncryptInit");
    if (aadlen && !EVP_EncryptUpdate(ctx, NULL, &l1, aad, aadlen)) die("aad");
    if (!EVP_EncryptUpdate(ctx, out, &l1, in, len)) die("EncryptUpdate");
    if (!EVP_EncryptFinal_ex(ctx, out + l1, &l2)) die("EncryptFinal");
    if (!EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_GET_TAG, 16, tag)) die("GET_TAG");
    return l1 + l2;
}

static int decrypt1(EVP_CIPHER_CTX *ctx, const EVP_CIPHER *c, const unsigned char *key, const unsigned char *iv,
                    const unsigned char *aad, int aadlen, const unsigned char *in, int len,
                    unsigned char *tag, unsigned char *out) {
    int l1 = 0, l2 = 0;
    if (!EVP_DecryptInit_ex(ctx, c, NULL, key, iv)) die("DecryptInit");
    if (aadlen && !EVP_DecryptUpdate(ctx, NULL, &l1, aad, aadlen)) die("aad");
    if (!EVP_DecryptUpdate(ctx, out, &l1, in, len)) die("DecryptUpdate");
    if (!EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_SET_TAG, 16, tag)) die("SET_TAG");
    if (EVP_DecryptFinal_ex(ctx, out + l1, &l2) <= 0) die("tag verification failed");
    return l1 + l2;
}

static int unhex(const char *h, unsigned char *out) {
    int n = (int)strlen(h) / 2;
    for (int i = 0; i < n; i++) sscanf(h + 2 * i, "%2hhx", &out[i]);
    return n;
}

/* NIST GCM spec test cases 4 and 16 (same vectors as the Java self-test). */
static void self_test(void) {
    static const char *v[2][6] = {
        {"feffe9928665731c6d6a8f9467308308", "cafebabefacedbaddecaf888",
         "d9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a721c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b39",
         "feedfacedeadbeeffeedfacedeadbeefabaddad2",
         "42831ec2217774244b7221b784d0d49ce3aa212f2c02a4e035c17e2329aca12e21d514b25466931c7d8f6a5aac84aa051ba30b396a0aac973d58e091",
         "5bc94fbc3221a5db94fae95ae7121a47"},
        {"feffe9928665731c6d6a8f9467308308feffe9928665731c6d6a8f9467308308", "cafebabefacedbaddecaf888",
         "d9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a721c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b39",
         "feedfacedeadbeeffeedfacedeadbeefabaddad2",
         "522dc1f099567d07f47f37a32a84427d643a8cdcbfe5c0c97598a2bd2555d1aa8cb08e48590dbb3da7b08b1056828838c5f61e6393ba7a0abcc9f662",
         "76fc6ece0f4e1768cddf8853bb2d551b"}};
    EVP_CIPHER_CTX *ctx = EVP_CIPHER_CTX_new();
    for (int i = 0; i < 2; i++) {
        unsigned char key[32], iv[12], pt[64], aad[32], ct[64], tag[16], got[64], gtag[16], back[64];
        int kl = unhex(v[i][0], key);
        unhex(v[i][1], iv);
        int pl = unhex(v[i][2], pt), al = unhex(v[i][3], aad);
        unhex(v[i][4], ct);
        unhex(v[i][5], tag);
        encrypt1(ctx, cipher_for(kl * 8), key, iv, aad, al, pt, pl, got, gtag);
        if (memcmp(got, ct, pl) || memcmp(gtag, tag, 16)) die("self-test encrypt mismatch");
        decrypt1(ctx, cipher_for(kl * 8), key, iv, aad, al, ct, pl, tag, back);
        if (memcmp(back, pt, pl)) die("self-test decrypt mismatch");
    }
    EVP_CIPHER_CTX_free(ctx);
}

/* returns ops; *elapsed set to seconds */
static unsigned long run(int bits, int size, int dec, double secs, double *elapsed) {
    const EVP_CIPHER *c = cipher_for(bits);
    EVP_CIPHER_CTX *ctx = EVP_CIPHER_CTX_new();
    unsigned char key[32], iv[12] = {0}, tag[16];
    unsigned char *in = malloc(size + 16), *out = malloc(size + 16), *ct = malloc(size + 16);
    memset(key, 0x42, sizeof key);
    for (int i = 0; i < size; i++) in[i] = (unsigned char)i;
    if (dec) encrypt1(ctx, c, key, iv, NULL, 0, in, size, ct, tag);
    if (!rekey) { /* set cipher+key once; per-op init passes only the IV */
        if (!(dec ? EVP_DecryptInit_ex : EVP_EncryptInit_ex)(ctx, c, NULL, key, NULL)) die("init");
    }
    const EVP_CIPHER *pc = rekey ? c : NULL;
    const unsigned char *pk = rekey ? key : NULL;

    int batch = size >= 65536 ? 1 : size >= 4096 ? 16 : 256;
    unsigned long ops = 0, ctr = 0;
    double start = now(), deadline = start + secs, t;
    do {
        for (int b = 0; b < batch; b++) {
            if (!dec) {
                ctr++;
                for (int j = 0; j < 8; j++) iv[11 - j] = (unsigned char)(ctr >> (8 * j));
                sink += encrypt1(ctx, pc, pk, iv, NULL, 0, in, size, out, tag);
            } else {
                sink += decrypt1(ctx, pc, pk, iv, NULL, 0, ct, size, tag, out);
            }
        }
        ops += batch;
        t = now();
    } while (t < deadline);
    *elapsed = t - start;
    free(in); free(out); free(ct);
    EVP_CIPHER_CTX_free(ctx);
    return ops;
}

int main(int argc, char **argv) {
    int self_test_only = 0;
    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "--seconds") && i + 1 < argc) seconds = atof(argv[++i]);
        else if (!strcmp(argv[i], "--warmup") && i + 1 < argc) warmup = atof(argv[++i]);
        else if (!strcmp(argv[i], "--sizes") && i + 1 < argc) nsizes = parse_list(argv[++i], sizes, 64);
        else if (!strcmp(argv[i], "--keys") && i + 1 < argc) nkeys = parse_list(argv[++i], keybits, 8);
        else if (!strcmp(argv[i], "--no-rekey")) rekey = 0;
        else if (!strcmp(argv[i], "--self-test")) self_test_only = 1;
        else { fprintf(stderr, "unknown arg: %s\n", argv[i]); return 2; }
    }
    self_test();
    if (self_test_only) { fprintf(stderr, "openssl self-test: OK\n"); return 0; }
    const char *impl = rekey ? "openssl-evp" : "openssl-evp-norekey";
    fprintf(stderr, "# %s, %s, warmup %.1fs\n", impl, OpenSSL_version(OPENSSL_VERSION), warmup);
    for (int k = 0; k < nkeys; k++) {
        double e;
        for (int s = 0; s < nsizes; s++) { run(keybits[k], sizes[s], 0, warmup / nsizes, &e); }
        for (int dec = 0; dec <= 1; dec++)
            for (int s = 0; s < nsizes; s++) {
                unsigned long ops = run(keybits[k], sizes[s], dec, seconds, &e);
                printf("%s,%s,%d,%d,%lu,%.6f,%.2f\n", impl, dec ? "dec" : "enc", keybits[k], sizes[s], ops, e,
                       (double)ops * sizes[s] / e / 1e6);
                fflush(stdout);
            }
    }
    fprintf(stderr, "# sink %lu\n", sink);
    return 0;
}
