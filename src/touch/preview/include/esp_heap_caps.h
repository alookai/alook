#pragma once
#include <stdlib.h>
#define MALLOC_CAP_SPIRAM 0
#define MALLOC_CAP_8BIT 0
static inline void* heap_caps_malloc(size_t size, int) { return malloc(size); }
static inline void* heap_caps_realloc(void* pointer, size_t size, int) { return realloc(pointer, size); }
static inline void heap_caps_free(void* pointer) { free(pointer); }
