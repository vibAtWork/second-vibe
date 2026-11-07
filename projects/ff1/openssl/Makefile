CC ?= cc
CFLAGS ?= -O2 -Wall -Wextra -std=c11 -D_POSIX_C_SOURCE=200809L
LDLIBS = -lcrypto

all: ff1_test ff1bench

ff1_test: ff1_test.c ff1.c ff1.h
	$(CC) $(CFLAGS) -o $@ ff1_test.c ff1.c $(LDLIBS)

ff1bench: ff1bench.c ff1.c ff1.h
	$(CC) $(CFLAGS) -o $@ ff1bench.c ff1.c $(LDLIBS)

test: ff1_test
	./ff1_test

clean:
	rm -f ff1_test ff1bench

.PHONY: all test clean
