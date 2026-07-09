UUID := smarttiling@samuelnovaes
ZIP := $(UUID).zip

.PHONY: all package install enable disable clean

all: package

package:
	npm run build

install: package
	gnome-extensions install --force $(ZIP)

enable:
	gnome-extensions enable $(UUID)

disable:
	gnome-extensions disable $(UUID)

clean:
	rm -rf -- dist $(ZIP)
