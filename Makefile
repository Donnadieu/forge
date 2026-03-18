.PHONY: all build test lint fmt fmt-check coverage

all: build fmt-check lint test

build:
	npm run build

test:
	npm test

lint:
	npm run lint

fmt:
	npm run fmt

fmt-check:
	npm run fmt:check

coverage:
	npm run test:coverage
