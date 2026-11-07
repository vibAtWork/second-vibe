/*
 * Where does OpenSSL's per-message time go? Times one AES-128-GCM seal per
 * message under progressively lighter re-initialisation:
 *
 *   A  EVP_EncryptInit_ex(ctx, EVP_aes_128_gcm(), key, iv)   what the "OpenSSL EVP" row does
 *   B  same, but with a cipher pre-fetched once via EVP_CIPHER_fetch
 *   C  EVP_EncryptInit_ex(ctx, NULL, key, iv)                re-key on the existing context
 *   D  EVP_EncryptInit_ex(ctx, NULL, NULL, iv)               IV only ("key set once" row)
 *
 * Build: cc -O2 -o ablate_openssl ablate_openssl.c -lcrypto
 */
#include <openssl/evp.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

static double now(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec + t.tv_nsec / 1e9; }
static volatile int sink;

static double bench(char mode, int size, double secs) {
    EVP_CIPHER_CTX *ctx = EVP_CIPHER_CTX_new();
    EVP_CIPHER *fetched = EVP_CIPHER_fetch(NULL, "AES-128-GCM", NULL);
    unsigned char key[16] = {0x42}, iv[12] = {0}, in[65536] = {0}, out[65536 + 16], tag[16];
    EVP_EncryptInit_ex(ctx, EVP_aes_128_gcm(), NULL, key, NULL);
    unsigned long ops = 0, ctr = 0;
    double t0 = now(), t;
    do {
        for (int b = 0; b < 1000; b++) {
            int l = 0;
            ctr++; memcpy(iv + 4, &ctr, 8);
            switch (mode) {
                case 'A': EVP_EncryptInit_ex(ctx, EVP_aes_128_gcm(), NULL, key, iv); break;
                case 'B': EVP_EncryptInit_ex(ctx, fetched, NULL, key, iv); break;
                case 'C': EVP_EncryptInit_ex(ctx, NULL, NULL, key, iv); break;
                case 'D': EVP_EncryptInit_ex(ctx, NULL, NULL, NULL, iv); break;
            }
            if (size) EVP_EncryptUpdate(ctx, out, &l, in, size);
            EVP_EncryptFinal_ex(ctx, out + l, &l);
            EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_GET_TAG, 16, tag);
            sink += tag[0];
        }
        ops += 1000;
    } while ((t = now()) - t0 < secs);
    EVP_CIPHER_free(fetched);
    EVP_CIPHER_CTX_free(ctx);
    return (t - t0) / ops * 1e9;
}

int main(int argc, char **argv) {
    double secs = argc > 1 ? atof(argv[1]) : 1.0;
    int sizes[] = {0, 16, 64, 1024, 16384};
    const char *names[] = {"A cipher+key+iv every msg", "B prefetched cipher+key+iv", "C key+iv (ctx kept)",
                           "D iv only"};
    printf("%-28s", "ns per message");
    for (int s = 0; s < 5; s++) printf("%9dB", sizes[s]);
    printf("\n");
    for (int m = 0; m < 4; m++) {
        printf("%-28s", names[m]);
        for (int s = 0; s < 5; s++) { bench("ABCD"[m], sizes[s], secs / 4); printf("%10.0f", bench("ABCD"[m], sizes[s], secs)); fflush(stdout); }
        printf("\n");
    }
    return 0;
}
