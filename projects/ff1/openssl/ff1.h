/*
 * NIST SP 800-38G FF1 format-preserving encryption on top of OpenSSL
 * libcrypto (EVP AES-ECB for the block cipher, BIGNUM for large domains,
 * unsigned __int128 for domains below 2^96).
 */
#ifndef FF1_H
#define FF1_H

#include <stddef.h>
#include <stdint.h>
#include <openssl/bn.h>
#include <openssl/evp.h>

typedef unsigned __int128 ff1_u128;

/* Per-(n, tweak length) values, cached on the context. */
typedef struct {
    int valid;
    size_t n, t, u, v;
    int b, d, fast;
    uint8_t enc_p[16];      /* CIPH_K(P) */
    ff1_u128 mod_u, mod_v;  /* fast path: radix^u, radix^v */
    struct ff1_recip {      /* Moller-Granlund reciprocal of a modulus */
        int s;              /* normalization shift */
        int wide;           /* modulus >= 2^64: 3-by-2 division */
        ff1_u128 d;         /* modulus << s */
        uint64_t v;         /* reciprocal */
    } rec_u, rec_v;
    BIGNUM *bmod_u, *bmod_v;
} ff1_params;

typedef struct {
    EVP_CIPHER_CTX *aes;
    BN_CTX *bn;
    BIGNUM *a, *b, *y; /* bignum-path scratch */
    unsigned radix;
    int group_len;      /* digits of radix per uint64 group */
    uint64_t group_pow; /* radix^group_len */
    uint64_t magic;     /* ceil(2^64 / radix), for division by radix */
    int force_bignum;   /* testing: disable the 128-bit fast path */
    ff1_params p;
} ff1_ctx;

enum {
    FF1_OK = 0,
    FF1_ERR_RADIX = -1,
    FF1_ERR_KEY = -2,
    FF1_ERR_LENGTH = -3,
    FF1_ERR_DIGIT = -4,
    FF1_ERR_INTERNAL = -5,
};

/* key_len must be 16, 24 or 32; radix in [2, 65536]. A context is not
 * thread-safe; use one per thread. */
int ff1_init(ff1_ctx *c, const uint8_t *key, size_t key_len, unsigned radix);
void ff1_free(ff1_ctx *c);

/* in and out are n digits each (each < radix); in == out is allowed. */
int ff1_encrypt(ff1_ctx *c, const uint8_t *tweak, size_t tweak_len,
                const uint16_t *in, uint16_t *out, size_t n);
int ff1_decrypt(ff1_ctx *c, const uint8_t *tweak, size_t tweak_len,
                const uint16_t *in, uint16_t *out, size_t n);

#endif
