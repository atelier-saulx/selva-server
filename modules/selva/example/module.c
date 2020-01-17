#include <uuid/uuid.h>
#include "../redismodule.h"
#include "../rmutil/util.h"
#include "../rmutil/strings.h"
#include "../rmutil/test_util.h"

char *genUuid(char *uuid_str) {
  uuid_t uuid;

  uuid_generate(uuid);
  uuid_unparse_lower(uuid, uuid_str);

  return uuid_str;
}

int hash(char *hash_str, char *str, size_t strlen) {
  int hash = 5381;
  size_t i = strlen;
  while (i) {
    hash = (hash * 33) ^ (int)(str[--i]);
  }

  return sprintf(hash_str, "%x", (unsigned int)hash >> 0);
}

int GenId(RedisModuleCtx *ctx, RedisModuleString **argv, int argc) {
  // init auto memory for created strings
  // RedisModule_AutoMemory(ctx);

  if (argc > 2) {
    return RedisModule_WrongArity(ctx);
  }

  if (argc == 2) {
    const char *uuid_str = RedisModule_StringPtrLen(argv[1], NULL);
    RedisModule_Log(ctx, "notice", "EXTERNAL: %s", uuid_str);
    char hash_str[37];
    hash(hash_str, uuid_str, strlen(uuid_str));
    RedisModule_ReplyWithSimpleString(ctx, hash_str);
    return REDISMODULE_OK;
  } else {
    char uuid_str[37];
    genUuid(uuid_str);
    RedisModule_Log(ctx, "notice", "UUID: %s", uuid_str);
    char hash_str[37];
    hash(hash_str, uuid_str, 37);
    RedisModule_ReplyWithSimpleString(ctx, hash_str);
    return REDISMODULE_OK;
  }
}

int RedisModule_OnLoad(RedisModuleCtx *ctx) {

  // Register the module itself
  if (RedisModule_Init(ctx, "example", 1, REDISMODULE_APIVER_1) == REDISMODULE_ERR) {
    return REDISMODULE_ERR;
  }

  // register example.parse - the default registration syntax
  if (RedisModule_CreateCommand(ctx, "selva.id", GenId, "readonly", 1, 1, 1) == REDISMODULE_ERR) {
    return REDISMODULE_ERR;
  }

  return REDISMODULE_OK;
}
