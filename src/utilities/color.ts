/**
 * This is taken directly from irc-colors <https://github.com/fent/irc-colors.js>
 * @TODO turn this into a TS module or create d.ts for irc-colors
 */

const Hash = require('hashish');

const colors = {
  '00': ['white'],
  '01': ['black'],
  '02': ['navy'],
  '03': ['green'],
  '04': ['red'],
  '05': ['brown', 'maroon'],
  '06': ['purple', 'violet'],
  '07': ['olive'],
  '08': ['yellow'],
  '09': ['lightgreen', 'lime'],
  '10': ['teal', 'bluecyan'],
  '11': ['cyan', 'aqua'],
  '12': ['blue', 'royal'],
  '13': ['pink', 'lightpurple', 'fuchsia'],
  '14': ['gray', 'grey'],
  '15': ['lightgray', 'lightgrey', 'silver'],
};

const styles = {
  '\x0F': 'normal',
  '\x1F': 'underline',
  '\x02': 'bold',
  '\x16': 'italic',
};

// coloring character
const c = '\x03';
const pos2 = c.length + 2;
const zero = '\u200B';

// make color functions for both foreground and background
Hash(colors).forEach(function (colornames: string[], code: string) {
  // foreground
  const fg = function (str: string) {
    return c + code + zero + str + c;
  };

  // background
  const bg = function (str: string) {
    const pos = str.indexOf(c);
    if (pos !== 0) {
      return c + '01,' + code + str + c;
    } else {
      return str.substr(pos, pos2) + ',' + code + str.substr(pos2);
    }
  };

  colornames.forEach(function (color) {
    exports[color] = fg;
    exports['bg' + color] = bg;
  });
});

// style functions
Hash(styles).forEach(function (style: string, code: string) {
  exports[style] = function (str: string) {
    return code + str + code;
  };
});

// extras
exports.rainbow = function (str: string, colorArr?: string[]): string {
  const rainbow = ['red', 'olive', 'yellow', 'green', 'blue', 'navy', 'violet'];
  colorArr = colorArr ? colorArr : rainbow;
  const length = colorArr.length;
  let index = 0;

  return str
    .split('')
    .map((color) =>
      color !== ' ' ? exports[colorArr[index++ % length]](color) : color,
    )
    .join('');
};

exports.stripColors = function (str: string): string {
  return str.replace(/(\x03\d{0,2}(,\d{0,2})?|\u200B)/g, '');
};

exports.stripStyle = function (str: string): string {
  return str.replace(/[\x0F\x02\x16\x1F]/g, '');
};

exports.stripColorsAndStyle = function (str: string): string {
  return exports.stripColors(exports.stripStyle(str));
};

// adds all functions to each other so they can be chained
const addGetters = function (f1: any, name: string): void {
  Hash(exports)
    .exclude([name])
    .forEach(function (f2: any, name: string) {
      f1.__defineGetter__(name, function () {
        const f = function (str: string) {
          return f2(f1(str));
        };
        addGetters(f, name);
        return f;
      });
    });
};

Hash(exports).forEach(function (f: any, name: string) {
  addGetters(f, name);
});

// adds functions to global String object
exports.global = function () {
  let t: any,
    irc = {};

  /**
   * TypeScript likes defineProperty much better than __defineGetter__
   */
  Object.defineProperty(String.prototype, 'irc', {
    get: function () {
      t = this;
      return irc;
    },
  });

  // String.prototype.__defineGetter__( 'irc', function() {
  //   t = this;
  //   return irc;
  // });

  const addGlobalGetters = function (f1: any, name: string) {
    Hash(exports)
      .exclude([name])
      .forEach(function (f2: any, name: string) {
        f1.__defineGetter__(name, function () {
          const f = function () {
            return f2(f1(t));
          };
          addGetters(f, name);
          return f;
        });
      });
  };

  Hash(exports)
    .exclude(['global'])
    .forEach(function (f1: any, name: string) {
      const f = function () {
        return f1(t);
      };
      addGlobalGetters(f, name);
      (irc as any)[name] = f;
    });
};
