.PHONY: all build test lint fmt fmt-check coverage

all: build fmt-check lint test

build:
	pnpm run build

test:
	pnpm test

lint:
	pnpm run lint

fmt:
	pnpm run fmt

fmt-check:
	pnpm run fmt:check

coverage:
	pnpm run test:coverage
