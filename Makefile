UUID := ipflag@cdrcqnts.github.io
ZIP  := $(UUID).shell-extension.zip
SRCS := metadata.json extension.js stylesheet.css

.PHONY: pack install uninstall clean

pack: $(ZIP)

$(ZIP): $(SRCS) LICENSE README.md
	gnome-extensions pack --force --extra-source=LICENSE --extra-source=README.md .

install: $(ZIP)
	gnome-extensions install --force $(ZIP)
	@echo "Installed. Log out and back in (Wayland), then: gnome-extensions enable $(UUID)"

uninstall:
	gnome-extensions uninstall $(UUID)

clean:
	rm -f $(ZIP)
