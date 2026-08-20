#ifdef __APPLE__
#define _DARWIN_C_SOURCE
#else
#define _POSIX_C_SOURCE 200809L
#endif
#define NAPI_VERSION 8

#include <node_api.h>

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#ifndef O_CLOEXEC
#define O_CLOEXEC 0
#endif

#ifndef O_DIRECTORY
#define O_DIRECTORY 0
#endif

static const char *errno_code(int value) {
  switch (value) {
    case EACCES: return "EACCES";
    case EEXIST: return "EEXIST";
    case EINVAL: return "EINVAL";
    case EIO: return "EIO";
    case ELOOP: return "ELOOP";
    case EMFILE: return "EMFILE";
    case ENAMETOOLONG: return "ENAMETOOLONG";
    case ENFILE: return "ENFILE";
    case ENOENT: return "ENOENT";
    case ENOMEM: return "ENOMEM";
    case ENOSPC: return "ENOSPC";
    case ENOTDIR: return "ENOTDIR";
    case EPERM: return "EPERM";
    case EROFS: return "EROFS";
    default: return "EUNKNOWN";
  }
}

static napi_value throw_errno(napi_env env, int value) {
  napi_throw_error(env, errno_code(value), strerror(value));
  return NULL;
}

static int read_int32(napi_env env, napi_value value, int32_t *output) {
  return napi_get_value_int32(env, value, output) == napi_ok;
}

static char *read_string(napi_env env, napi_value value) {
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, NULL, 0, &length) != napi_ok) return NULL;
  char *result = malloc(length + 1);
  if (result == NULL) return NULL;
  if (napi_get_value_string_utf8(env, value, result, length + 1, &length) != napi_ok) {
    free(result);
    return NULL;
  }
  return result;
}

static int valid_name(const char *name) {
  return name[0] != '\0' && strcmp(name, ".") != 0 && strcmp(name, "..") != 0 && strchr(name, '/') == NULL;
}

static napi_value fd_value(napi_env env, int fd) {
  napi_value result;
  if (napi_create_int32(env, fd, &result) != napi_ok) {
    close(fd);
    return NULL;
  }
  return result;
}

static napi_value open_directory(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 1) {
    napi_throw_type_error(env, "EINVAL", "openDirectory expects one path");
    return NULL;
  }
  char *path = read_string(env, argv[0]);
  if (path == NULL) {
    napi_throw_type_error(env, "EINVAL", "openDirectory path must be a string");
    return NULL;
  }
  int fd = open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  int failure = errno;
  free(path);
  if (fd < 0) return throw_errno(env, failure);
  return fd_value(env, fd);
}

static napi_value open_at(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value argv[4];
  int32_t directory_fd;
  int32_t flags;
  int32_t mode;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 4
      || !read_int32(env, argv[0], &directory_fd) || !read_int32(env, argv[2], &flags)
      || !read_int32(env, argv[3], &mode)) {
    napi_throw_type_error(env, "EINVAL", "openAt expects directory fd, name, flags, and mode");
    return NULL;
  }
  char *name = read_string(env, argv[1]);
  if (name == NULL || !valid_name(name)) {
    free(name);
    napi_throw_type_error(env, "EINVAL", "openAt name must be one path component");
    return NULL;
  }
  int fd = openat(directory_fd, name, flags | O_NOFOLLOW | O_CLOEXEC, (mode_t)mode);
  int failure = errno;
  free(name);
  if (fd < 0) return throw_errno(env, failure);
  return fd_value(env, fd);
}

static napi_value mkdir_at(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  int32_t directory_fd;
  int32_t mode;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 3
      || !read_int32(env, argv[0], &directory_fd) || !read_int32(env, argv[2], &mode)) {
    napi_throw_type_error(env, "EINVAL", "mkdirAt expects directory fd, name, and mode");
    return NULL;
  }
  char *name = read_string(env, argv[1]);
  if (name == NULL || !valid_name(name)) {
    free(name);
    napi_throw_type_error(env, "EINVAL", "mkdirAt name must be one path component");
    return NULL;
  }
  int result = mkdirat(directory_fd, name, (mode_t)mode);
  int failure = errno;
  free(name);
  if (result < 0) return throw_errno(env, failure);
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

static napi_value rename_at(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  int32_t directory_fd;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 3
      || !read_int32(env, argv[0], &directory_fd)) {
    napi_throw_type_error(env, "EINVAL", "renameAt expects directory fd and two names");
    return NULL;
  }
  char *source = read_string(env, argv[1]);
  char *destination = read_string(env, argv[2]);
  if (source == NULL || destination == NULL || !valid_name(source) || !valid_name(destination)) {
    free(source);
    free(destination);
    napi_throw_type_error(env, "EINVAL", "renameAt names must each be one path component");
    return NULL;
  }
  int result = renameat(directory_fd, source, directory_fd, destination);
  int failure = errno;
  free(source);
  free(destination);
  if (result < 0) return throw_errno(env, failure);
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

static napi_value unlink_at(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  int32_t directory_fd;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 2
      || !read_int32(env, argv[0], &directory_fd)) {
    napi_throw_type_error(env, "EINVAL", "unlinkAt expects directory fd and name");
    return NULL;
  }
  char *name = read_string(env, argv[1]);
  if (name == NULL || !valid_name(name)) {
    free(name);
    napi_throw_type_error(env, "EINVAL", "unlinkAt name must be one path component");
    return NULL;
  }
  int result = unlinkat(directory_fd, name, 0);
  int failure = errno;
  free(name);
  if (result < 0) return throw_errno(env, failure);
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

static napi_value list_at(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  int32_t directory_fd;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 1
      || !read_int32(env, argv[0], &directory_fd)) {
    napi_throw_type_error(env, "EINVAL", "listAt expects one directory fd");
    return NULL;
  }
  int copied = dup(directory_fd);
  if (copied < 0) return throw_errno(env, errno);
  DIR *directory = fdopendir(copied);
  if (directory == NULL) {
    int failure = errno;
    close(copied);
    return throw_errno(env, failure);
  }
  napi_value entries;
  if (napi_create_array(env, &entries) != napi_ok) {
    closedir(directory);
    return NULL;
  }
  uint32_t index = 0;
  errno = 0;
  struct dirent *entry;
  while ((entry = readdir(directory)) != NULL) {
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
    napi_value name;
    if (napi_create_string_utf8(env, entry->d_name, NAPI_AUTO_LENGTH, &name) != napi_ok
        || napi_set_element(env, entries, index++, name) != napi_ok) {
      closedir(directory);
      return NULL;
    }
  }
  int failure = errno;
  closedir(directory);
  if (failure != 0) return throw_errno(env, failure);
  return entries;
}

static napi_value initialize(napi_env env, napi_value exports) {
  const napi_property_descriptor properties[] = {
    { "openDirectory", NULL, open_directory, NULL, NULL, NULL, napi_default, NULL },
    { "openAt", NULL, open_at, NULL, NULL, NULL, napi_default, NULL },
    { "mkdirAt", NULL, mkdir_at, NULL, NULL, NULL, napi_default, NULL },
    { "renameAt", NULL, rename_at, NULL, NULL, NULL, napi_default, NULL },
    { "unlinkAt", NULL, unlink_at, NULL, NULL, NULL, napi_default, NULL },
    { "listAt", NULL, list_at, NULL, NULL, NULL, napi_default, NULL },
  };
  if (napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties) != napi_ok) return NULL;
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
